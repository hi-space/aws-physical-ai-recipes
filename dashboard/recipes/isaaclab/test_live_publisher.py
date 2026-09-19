"""Unit tests for isaaclab.live.LiveStepPublisher.

Runs without isaaclab/gymnasium: a fake env supplies step()/render()/unwrapped
and arbitrary attributes; a fake LiveFrames gives deterministic due() control.
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from live import LiveStepPublisher  # noqa: E402


class FakeEnv:
    def __init__(self, render_error=None):
        self.num_envs = 4
        self.num_actions = 6
        self.num_obs = 10
        self.device = "cpu"
        self.cfg = object()
        self.render_calls = 0
        self.step_args = []
        self._render_error = render_error

    def step(self, actions):
        self.step_args.append(actions)
        return ("obs", 1.0, False, {})

    def render(self):
        self.render_calls += 1
        if self._render_error is not None:
            raise self._render_error
        return f"frame-{self.render_calls}"

    def reset(self):
        return "reset-obs"

    @property
    def unwrapped(self):
        return self


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

    def test_render_failure_does_not_crash_step(self):
        env = FakeEnv(render_error=RuntimeError("gpu render blew up"))
        frames = FakeFrames([True])
        pub = LiveStepPublisher(env, frames)

        with self.assertLogs("live", level="WARNING"):
            result = pub.step("a")
        self.assertEqual(result, ("obs", 1.0, False, {}))
        self.assertEqual(env.render_calls, 1)
        self.assertEqual(frames.published, [], "no frame published when render fails")

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
