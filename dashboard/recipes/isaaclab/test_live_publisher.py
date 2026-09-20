"""Unit tests for isaaclab.live.LiveStepPublisher.

Runs without isaaclab/gymnasium: a fake env supplies step()/render()/unwrapped
and arbitrary attributes; a fake LiveFrames gives deterministic due() control;
a fake app_update counter stands in for omni.kit.app so the warm-up/retry path
is exercised without the Isaac Sim runtime.
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from live import LiveStepPublisher, _WARMUP_ATTEMPTS, _WARMUP_UPDATES  # noqa: E402


class FakeFrame:
    """Stand-in for a rendered array carrying just the ``size`` the warm-up checks."""

    def __init__(self, size, label="frame"):
        self.size = size
        self.label = label

    def __eq__(self, other):
        return isinstance(other, FakeFrame) and (self.size, self.label) == (other.size, other.label)

    def __repr__(self):
        return f"FakeFrame(size={self.size}, label={self.label!r})"


class FakeEnv:
    def __init__(self, render_error=None, render_script=None):
        self.num_envs = 4
        self.num_actions = 6
        self.num_obs = 10
        self.device = "cpu"
        self.cfg = object()
        self.render_calls = 0
        self.step_args = []
        self._render_error = render_error
        # render_script: per-call outcomes; an Exception entry is raised, any
        # other entry is returned. Once exhausted the last entry repeats.
        self._script = list(render_script) if render_script is not None else None
        self._last = None

    def step(self, actions):
        self.step_args.append(actions)
        return ("obs", 1.0, False, {})

    def render(self):
        self.render_calls += 1
        if self._render_error is not None:
            raise self._render_error
        if self._script is not None:
            if self._script:
                self._last = self._script.pop(0)
            outcome = self._last
            if isinstance(outcome, BaseException):
                raise outcome
            return outcome
        return f"frame-{self.render_calls}"

    def reset(self):
        return "reset-obs"

    @property
    def unwrapped(self):
        return self


class FakePump:
    """Counts app.update() calls in place of omni.kit.app.get_app().update."""

    def __init__(self):
        self.calls = 0

    def __call__(self):
        self.calls += 1


class FakeFrames:
    """Deterministic LiveFrames double: due() follows a scripted sequence."""

    def __init__(self, due_sequence):
        self._due = list(due_sequence)
        self.published = []

    def due(self):
        return self._due.pop(0) if self._due else False

    def publish(self, frame):
        self.published.append(frame)
        return True


class LiveStepPublisherTests(unittest.TestCase):
    def test_step_returns_env_result_and_forwards_actions(self):
        env, frames = FakeEnv(), FakeFrames([False])
        pub = LiveStepPublisher(env, frames)

        result = pub.step("actions")
        self.assertEqual(result, ("obs", 1.0, False, {}))
        self.assertEqual(env.step_args, ["actions"])

    def test_renders_and_publishes_only_when_due(self):
        env = FakeEnv()
        # due, then not due, then due again
        frames = FakeFrames([True, False, True])
        pub = LiveStepPublisher(env, frames)

        pub.step("a")
        self.assertEqual(env.render_calls, 1)
        self.assertEqual(frames.published, ["frame-1"])

        pub.step("a")  # not due → no render, no publish
        self.assertEqual(env.render_calls, 1)
        self.assertEqual(frames.published, ["frame-1"])

        pub.step("a")  # due again
        self.assertEqual(env.render_calls, 2)
        self.assertEqual(frames.published, ["frame-1", "frame-2"])

    def test_attribute_access_delegates(self):
        env, frames = FakeEnv(), FakeFrames([])
        pub = LiveStepPublisher(env, frames)

        self.assertEqual(pub.num_envs, 4)
        self.assertEqual(pub.num_actions, 6)
        self.assertEqual(pub.num_obs, 10)
        self.assertEqual(pub.device, "cpu")
        self.assertIs(pub.cfg, env.cfg)
        self.assertEqual(pub.reset(), "reset-obs")

    def test_unwrapped_resolves_through_wrapper(self):
        env, frames = FakeEnv(), FakeFrames([])
        pub = LiveStepPublisher(env, frames)
        self.assertIs(pub.unwrapped, env)

    def test_persistent_render_failure_gives_up_after_bounded_warmup(self):
        env = FakeEnv(render_error=RuntimeError("gpu render blew up"))
        frames = FakeFrames([True])
        pump = FakePump()
        pub = LiveStepPublisher(env, frames, app_update=pump)

        with self.assertLogs("live", level="WARNING"):
            result = pub.step("a")
        self.assertEqual(result, ("obs", 1.0, False, {}))
        # The first capture retries render() up to the warm-up bound, pumping
        # app updates between attempts (one fewer gap than attempts).
        self.assertEqual(env.render_calls, _WARMUP_ATTEMPTS)
        self.assertEqual(pump.calls, (_WARMUP_ATTEMPTS - 1) * _WARMUP_UPDATES)
        self.assertEqual(frames.published, [], "no frame published when render never succeeds")

    def test_warmup_retries_then_publishes_first_good_frame(self):
        # render() raises the replicator data-window error twice, then succeeds.
        good = FakeFrame(size=720 * 1280 * 3, label="live")
        overscan = TypeError("unsupported operand type(s) for -: 'NoneType' and 'NoneType'")
        env = FakeEnv(render_script=[overscan, overscan, good])
        frames = FakeFrames([True])
        pump = FakePump()
        pub = LiveStepPublisher(env, frames, app_update=pump)

        result = pub.step("a")
        self.assertEqual(result, ("obs", 1.0, False, {}))
        self.assertEqual(env.render_calls, 3, "retried until render stopped raising")
        self.assertEqual(pump.calls, 2 * _WARMUP_UPDATES, "pumped between the two failures")
        self.assertEqual(frames.published, [good])
        self.assertTrue(pub._warmed_up)

    def test_warmup_skips_empty_frames_until_pipeline_ready(self):
        # get_data() returns size-0 "warming up" arrays before a real frame.
        empty = FakeFrame(size=0, label="warmup")
        good = FakeFrame(size=100, label="live")
        env = FakeEnv(render_script=[empty, empty, good])
        frames = FakeFrames([True])
        pump = FakePump()
        pub = LiveStepPublisher(env, frames, app_update=pump)

        pub.step("a")
        self.assertEqual(env.render_calls, 3)
        self.assertEqual(pump.calls, 2 * _WARMUP_UPDATES)
        self.assertEqual(frames.published, [good], "empty warm-up frames are not published")

    def test_no_pump_after_warmup_succeeds(self):
        # Once warmed, later captures call render() directly with no extra pumping.
        good1 = FakeFrame(size=100, label="a")
        good2 = FakeFrame(size=100, label="b")
        env = FakeEnv(render_script=[good1, good2])
        frames = FakeFrames([True, True])
        pump = FakePump()
        pub = LiveStepPublisher(env, frames, app_update=pump)

        pub.step("x")
        self.assertEqual(pump.calls, 0, "no pump needed when first render succeeds")
        self.assertEqual(env.render_calls, 1)

        pub.step("y")
        self.assertEqual(pump.calls, 0, "warmed-up path never pumps")
        self.assertEqual(env.render_calls, 2)
        self.assertEqual(frames.published, [good1, good2])

    def test_render_failure_after_warmup_does_not_crash_step(self):
        # After a successful warm-up, a transient render error on a later step is
        # swallowed and logged, and step() still returns the env result.
        good = FakeFrame(size=100, label="a")
        env = FakeEnv(render_script=[good, RuntimeError("transient gpu hiccup")])
        frames = FakeFrames([True, True])
        pump = FakePump()
        pub = LiveStepPublisher(env, frames, app_update=pump)

        pub.step("x")  # warm-up succeeds, publishes good
        with self.assertLogs("live", level="WARNING"):
            result = pub.step("y")  # later render raises → swallowed
        self.assertEqual(result, ("obs", 1.0, False, {}))
        self.assertEqual(frames.published, [good], "no frame published for the failed later render")

    def test_publish_failure_does_not_crash_step(self):
        env = FakeEnv()

        class ExplodingFrames(FakeFrames):
            def publish(self, frame):
                raise OSError("PAI_LIVE_DIR is full")

        frames = ExplodingFrames([True])
        pub = LiveStepPublisher(env, frames)

        with self.assertLogs("live", level="WARNING"):
            result = pub.step("a")
        self.assertEqual(result, ("obs", 1.0, False, {}), "step returns env result despite publish failure")
        self.assertEqual(env.render_calls, 1)

    def test_getattr_guards_private_names_against_recursion(self):
        # Missing private attribute raises AttributeError rather than recursing.
        pub = LiveStepPublisher(FakeEnv(), FakeFrames([]))
        with self.assertRaises(AttributeError):
            pub._never_set  # noqa: B018

        # If _env was never assigned (e.g. unpickle/copy), delegation of a public
        # attribute must raise AttributeError, not RecursionError.
        bare = LiveStepPublisher.__new__(LiveStepPublisher)
        with self.assertRaises(AttributeError):
            bare.num_envs  # noqa: B018


if __name__ == "__main__":
    unittest.main()
