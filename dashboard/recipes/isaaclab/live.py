"""Live frame publisher wrapper for Isaac Lab environments."""
import logging
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from pai_live import LiveFrames  # noqa: E402 — sibling recipe module, added to path above

log = logging.getLogger(__name__)

_ERROR_LOG_INTERVAL = 60.0  # seconds; throttle publish-failure warnings to avoid log spam


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
    """

    def __init__(self, env, frames: LiveFrames):
        self._env = env
        self._frames = frames
        self._last_error_log = 0.0

    def step(self, actions):
        result = self._env.step(actions)
        if self._frames.due():
            try:
                frame = self._env.unwrapped.render()
                if frame is not None:
                    self._frames.publish(frame)
            except Exception:
                self._log_capture_failure()
        return result

    def _log_capture_failure(self):
        now = time.monotonic()
        if now - self._last_error_log >= _ERROR_LOG_INTERVAL:
            self._last_error_log = now
            log.warning("live-view frame capture failed; continuing training", exc_info=True)

    def __getattr__(self, name):
        # Reached only for attributes not defined on the wrapper. Refuse private
        # names so that, if _env was never set (unpickle/copy), we raise
        # AttributeError instead of recursing on self._env.
        if name.startswith("_"):
            raise AttributeError(name)
        return getattr(self._env, name)
