"""CPU tests for the Replicator SDG recipe's non-Isaac helpers (no Isaac Sim needed).

The 2026-09-19 g6e verification showed that, as uid 1000, Kit cannot create /isaac-sim/kit/cache and the
RTX renderer silently never starts, so orchestrator.step() spins forever. These tests pin the two guards
added for that: a writable portable root and a first-frame watchdog that turns the hang into an exit.
"""
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import generate  # noqa: E402


class PortableRoot(unittest.TestCase):
    def test_uses_xdg_cache_home_when_set(self):
        with tempfile.TemporaryDirectory() as tmp:
            old = os.environ.get("XDG_CACHE_HOME")
            os.environ["XDG_CACHE_HOME"] = tmp
            try:
                root = generate.kit_portable_root()
            finally:
                if old is None:
                    del os.environ["XDG_CACHE_HOME"]
                else:
                    os.environ["XDG_CACHE_HOME"] = old
            self.assertEqual(root, Path(tmp) / "isaac-kit-portable")
            self.assertTrue(root.is_dir())

    def test_falls_back_to_tmp(self):
        old = os.environ.pop("XDG_CACHE_HOME", None)
        try:
            self.assertEqual(generate.kit_portable_root(), Path("/tmp/isaac-kit-portable"))
        finally:
            if old is not None:
                os.environ["XDG_CACHE_HOME"] = old


class RgbBlackCheck(unittest.TestCase):
    def write(self, value: int) -> Path:
        from PIL import Image
        path = Path(tempfile.mkdtemp(prefix="sdg-rgb-")) / "rgb_0000.png"
        Image.new("RGBA", (8, 6), (value, value, value, 255)).save(path)
        return path

    def test_black_frame_fails(self):
        with self.assertRaisesRegex(RuntimeError, "RGB pass is black"):
            generate.assert_rgb_not_black(self.write(1), 2.0)

    def test_lit_frame_passes_and_zero_threshold_disables(self):
        self.assertAlmostEqual(generate.assert_rgb_not_black(self.write(120), 2.0), 120.0)
        self.assertAlmostEqual(generate.assert_rgb_not_black(self.write(0), 0), 0.0)


WATCHDOG = """
import sys, time
sys.path.insert(0, {here!r})
import generate
from pathlib import Path
frames = Path({frames!r})
generate.first_frame_watchdog(frames, {timeout})
if {produce}:
    frames.mkdir(parents=True, exist_ok=True)
    (frames / "rgb_0000.png").write_bytes(b"x")
time.sleep({sleep})
print("main finished")
"""


class FirstFrameWatchdog(unittest.TestCase):
    def run_child(self, produce: bool, timeout: float, sleep: float):
        with tempfile.TemporaryDirectory() as tmp:
            code = WATCHDOG.format(here=str(HERE), frames=str(Path(tmp) / "frames"), timeout=timeout, produce=produce, sleep=sleep)
            return subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=60)

    def test_exits_3_when_no_frame_arrives(self):
        result = self.run_child(produce=False, timeout=0.2, sleep=30)
        self.assertEqual(result.returncode, 3, result.stderr)
        self.assertIn("no frame within", result.stderr)

    def test_stays_quiet_once_a_frame_exists(self):
        result = self.run_child(produce=True, timeout=1, sleep=1.5)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("main finished", result.stdout)


if __name__ == "__main__":
    unittest.main()
