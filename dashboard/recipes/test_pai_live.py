"""Unit tests for pai_live.LiveFrames — no imageio/isaac/mujoco imports.

The JPEG encoder is injected via ``writer=`` so rate limiting and the atomic
rename can be exercised on machines without imageio installed.
"""
import os
import tempfile
import time
import unittest
from pathlib import Path

from pai_live import LiveFrames


class RecordingWriter:
    """Stand-in for the imageio encoder: records calls and writes real bytes."""

    def __init__(self):
        self.frames = []
        self.targets = []

    def __call__(self, target, frame):
        self.frames.append(frame)
        self.targets.append(Path(target))
        Path(target).write_bytes(b"JPEG-BYTES")


class LiveFramesDisabledTests(unittest.TestCase):
    def setUp(self):
        os.environ.pop("PAI_LIVE_DIR", None)

    def test_disabled_without_dir(self):
        writer = RecordingWriter()
        frames = LiveFrames(writer=writer)
        self.assertFalse(frames.enabled)
        self.assertFalse(frames.due())
        self.assertFalse(frames.publish(object()))
        self.assertEqual(writer.frames, [], "writer must not run when disabled")


class LiveFramesEnabledTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        os.environ["PAI_LIVE_DIR"] = self._tmp.name

    def tearDown(self):
        os.environ.pop("PAI_LIVE_DIR", None)
        self._tmp.cleanup()

    def test_publish_writes_frame_atomically(self):
        writer = RecordingWriter()
        frames = LiveFrames(max_fps=10.0, writer=writer)
        marker = object()

        self.assertTrue(frames.publish(marker))
        self.assertIs(writer.frames[0], marker, "encoder must receive the frame")

        target = Path(self._tmp.name) / "frame.jpg"
        self.assertTrue(target.exists(), "published frame lands at frame.jpg")
        self.assertFalse((Path(self._tmp.name) / "frame.tmp.jpg").exists(),
                         "temporary file must be renamed away, not left behind")
        self.assertEqual(frames.count, 1)

    def test_rate_limited(self):
        writer = RecordingWriter()
        frames = LiveFrames(max_fps=10.0, writer=writer)

        self.assertTrue(frames.publish(object()))
        # Immediately again: still inside the 0.1s window → dropped.
        self.assertFalse(frames.publish(object()))
        self.assertEqual(len(writer.frames), 1)
        self.assertFalse(frames.due())

        time.sleep(0.11)
        self.assertTrue(frames.due())
        self.assertTrue(frames.publish(object()))
        self.assertEqual(len(writer.frames), 2)
        self.assertEqual(frames.count, 2)


if __name__ == "__main__":
    unittest.main()
