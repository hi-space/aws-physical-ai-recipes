"""Live frame publisher wrapper for Isaac Lab environments."""
import logging
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from pai_live import LiveFrames  # noqa: E402 — sibling recipe module, added to path above

log = logging.getLogger(__name__)

_ERROR_LOG_INTERVAL = 60.0  # seconds; throttle publish-failure warnings to avoid log spam

# Warm-up bounds for the first capture. Isaac Lab's ManagerBasedRLEnv.render()
# lazily creates a replicator render product + rgb annotator on its first call,
# then immediately calls annotator.get_data(). On this Isaac Sim 5.1 build the
# RTX pipeline has not yet populated the render product's data window, so
# replicator's _resize_data_for_overscan raises (TypeError: unsupported operand
# type(s) for -: 'NoneType' and 'NoneType') instead of returning the size-0
# "still warming up" array render() knows how to handle. Pumping a few
# omni.kit.app updates between retries lets the pipeline finish initialising so
# get_data() returns a real frame — verified on an A10G with the workshop task.
_WARMUP_ATTEMPTS = 8   # render() retries before giving up on the first capture
_WARMUP_UPDATES = 4    # app.update() ticks between warm-up attempts


class LiveStepPublisher:
    """Wrap a gym/RSL-RL env so a rendered frame is published after each step, bounded to ~max_fps.

    Only ``step`` is intercepted; every other attribute (num_envs, num_actions,
    num_obs, cfg, device, get_observations, reset, episode_length_buf,
    max_episode_length, unwrapped, …) delegates to the wrapped env so RSL-RL's
    OnPolicyRunner sees it unchanged.

    Frame capture is best-effort by design: a live-view sidecar must never take
    down a multi-hour training run, so both ``render()`` and ``publish()`` are
    guarded — any failure (render error, JPEG-encode error, disk-full/IO error on
    PAI_LIVE_DIR) is swallowed, logged at most once per minute, and ``step()``
    still returns the env result.

    The very first capture runs a bounded warm-up (see the module constants):
    ``render()`` is retried, pumping ``omni.kit.app`` updates in between, until it
    returns a frame without raising. This absorbs the transient replicator
    data-window race that otherwise makes every frame fail on Isaac Sim 5.1.
    """

    def __init__(self, env, frames: LiveFrames, app_update=None):
        self._env = env
        self._frames = frames
        self._last_error_log = 0.0
        self._warmed_up = False
        # Injectable for tests; resolved lazily to omni.kit.app on first use so
        # importing this module never requires the Isaac Sim runtime.
        self._app_update = app_update

    def step(self, actions):
        result = self._env.step(actions)
        if self._frames.due():
            try:
                frame = self._capture()
                if frame is not None:
                    self._frames.publish(frame)
            except Exception:
                self._log_capture_failure()
        return result

    def _capture(self):
        if not self._warmed_up:
            return self._warm_up()
        return self._env.unwrapped.render()

    def _warm_up(self):
        """First-capture warm-up: retry render(), pumping app updates in between,
        until it returns a usable frame without raising. Marks itself done
        regardless so the cost is paid once; if no frame ever materialises we log
        once and fall back to plain (guarded) render() on later steps.
        """
        last_exc = None
        for attempt in range(_WARMUP_ATTEMPTS):
            try:
                frame = self._env.unwrapped.render()
            except Exception as exc:  # noqa: BLE001 — best-effort; never crash training
                frame, last_exc = None, exc
            if frame is not None and getattr(frame, "size", 1) > 0:
                self._warmed_up = True
                return frame
            if attempt < _WARMUP_ATTEMPTS - 1:
                try:
                    self._pump(_WARMUP_UPDATES)
                except Exception as exc:  # noqa: BLE001 — app update unavailable/broken
                    last_exc = exc
                    break
        self._warmed_up = True
        self._log_capture_failure(last_exc)
        return None

    def _pump(self, ticks):
        """Advance the Omniverse app loop so the RTX render pipeline progresses."""
        update = self._app_update
        if update is None:
            import omni.kit.app  # lazy: only available inside the Isaac Sim app
            update = omni.kit.app.get_app().update
            self._app_update = update
        for _ in range(ticks):
            update()

    def _log_capture_failure(self, exc=None):
        now = time.monotonic()
        if now - self._last_error_log >= _ERROR_LOG_INTERVAL:
            self._last_error_log = now
            # exc_info=exc when we captured one during warm-up (no active
            # exception in scope); exc_info=True inside step()'s except handler.
            log.warning("live-view frame capture failed; continuing training",
                        exc_info=exc if exc is not None else True)

    def __getattr__(self, name):
        # Reached only for attributes not defined on the wrapper. Refuse private
        # names so that, if _env was never set (unpickle/copy), we raise
        # AttributeError instead of recursing on self._env.
        if name.startswith("_"):
            raise AttributeError(name)
        return getattr(self._env, name)
