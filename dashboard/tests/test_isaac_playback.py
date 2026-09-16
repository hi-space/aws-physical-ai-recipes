"""Verify private writable Kit storage survives playback and closes on failure."""
import ast
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest


def implementation(namespace):
    source = Path(__file__).resolve().parents[2] / "hyperpod-training/examples/rl/play_isaaclab.py"
    tree = ast.parse(source.read_text())
    main = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "main")
    exec(compile(ast.Module(body=[main], type_ignores=[]), str(source), "exec"), namespace)
    return namespace["main"]


class PlaybackStorageTests(unittest.TestCase):
    def exercise(self, fail=None):
        args = SimpleNamespace(kit_args="--/custom/setting=true")
        events, roots = [], []

        def launch(actual):
            self.assertTrue(actual.kit_args.startswith("--/custom/setting=true "))
            words = actual.kit_args.split()
            self.assertIn("--portable", words)
            root = Path(words[words.index("--portable-root") + 1])
            roots.append(root)
            self.assertEqual(root.stat().st_mode & 0o777, 0o700)
            (root / "cache").mkdir()
            (root / "cache/proof").write_text("writable")
            events.append("launch")
            if fail == "launch":
                raise RuntimeError("launch failure")

            def close():
                self.assertTrue(root.exists(), "Kit close must precede temporary directory cleanup")
                events.append("close")
            return SimpleNamespace(app=SimpleNamespace(close=close))

        def playback(actual, app):
            self.assertTrue(roots[0].exists())
            events.append("playback")
            if fail == "playback":
                raise RuntimeError("playback failure")

        main = implementation({"tempfile": tempfile, "parse_args": lambda: args,
                               "AppLauncher": launch, "_playback": playback})
        if fail:
            with self.assertRaisesRegex(RuntimeError, f"{fail} failure"):
                main()
        else:
            main()
        self.assertEqual(events, ["launch"] if fail == "launch" else ["launch", "playback", "close"])
        self.assertTrue(roots)
        self.assertFalse(roots[0].exists())

    def test_writable_storage_preserves_existing_arguments(self):
        self.exercise()

    def test_playback_failure_closes_app_before_removing_storage(self):
        self.exercise("playback")

    def test_launcher_failure_still_removes_private_storage(self):
        self.exercise("launch")


if __name__ == "__main__":
    unittest.main()
