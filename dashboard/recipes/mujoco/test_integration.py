"""Real CPU physics/optimizer integration; run inside the MuJoCo image."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class TrainingIntegration(unittest.TestCase):
    def test_train_resume_evaluate_and_reject_mismatched_statistics(self):
        scripts = Path(__file__).parent
        self.assertTrue((scripts / "train.py").is_file(), "real training entrypoint is required")
        from stable_baselines3 import PPO
        import numpy as np

        def run(script, *args, ok=True):
            result = subprocess.run(
                [sys.executable, str(scripts / script), *map(str, args)],
                capture_output=True, text=True, env={**os.environ, "MUJOCO_GL": "osmesa"},
            )
            if ok:
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            else:
                self.assertNotEqual(result.returncode, 0)
            return result

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            first, resumed, evaluation = [root / n for n in ("first", "resumed", "evaluation")]
            run("train.py", "--output-dir", first, "--total-steps", 512,
                "--num-envs", 2, "--n-steps", 64, "--batch-size", 64,
                "--checkpoint-every", 128, "--eval-episodes", 1, "--seed", 7)
            checkpoints = sorted((first / "checkpoints").glob("step-*"))
            self.assertGreaterEqual(len(checkpoints), 4)
            for checkpoint in checkpoints:
                manifest = json.loads((checkpoint / "manifest.json").read_text())
                for filename, digest in manifest["sha256"].items():
                    self.assertEqual(hashlib.sha256((checkpoint / filename).read_bytes()).hexdigest(), digest)
            before = PPO.load(first / "initial" / "model.zip", device="cpu")
            after = PPO.load(first / "final" / "model.zip", device="cpu")
            self.assertTrue(any(
                not np.array_equal(value.cpu().numpy(), after.policy.state_dict()[name].cpu().numpy())
                for name, value in before.policy.state_dict().items()
            ), "PPO must actually update weights")
            self.assertGreater(after._n_updates, 0)
            run("train.py", "--output-dir", resumed, "--resume", first / "final",
                "--total-steps", 256, "--num-envs", 2, "--n-steps", 64,
                "--batch-size", 64, "--checkpoint-every", 128, "--eval-episodes", 1, "--seed", 7)
            manifest = json.loads((resumed / "final/manifest.json").read_text())
            self.assertEqual(manifest["timesteps"], 768)
            self.assertGreater(manifest["normalization_count"],
                               json.loads((first / "final/manifest.json").read_text())["normalization_count"])
            run("evaluate.py", "--checkpoint", resumed / "final", "--output-dir", evaluation,
                "--episodes", 2, "--seed", 1007, "--width", 160, "--height", 128)
            result = json.loads((evaluation / "evaluation.json").read_text())
            self.assertEqual(result["type"], "closed_loop")
            self.assertEqual(result["episodeCount"], 2)
            self.assertEqual(result["seed"], 1007)
            self.assertEqual(result["successCount"], sum(e["success"] for e in result["episodes"]))
            self.assertTrue(all(e["steps"] == 200 for e in result["episodes"]))
            self.assertTrue(all(np.isfinite(e["return"]) for e in result["episodes"]))
            self.assertEqual(result["successRate"], result["successCount"] / 2)
            self.assertGreater(len(list((evaluation / "videos").glob("*.mp4"))), 0)
            import imageio.v2 as imageio
            reader = imageio.get_reader(evaluation / result["videoUri"])
            self.assertEqual(reader.get_next_data().shape[:2], (128, 160))
            reader.close()
            # Evaluation is reproducible and does not modify training statistics.
            replay = root / "replay"
            run("evaluate.py", "--checkpoint", resumed / "final", "--output-dir", replay,
                "--episodes", 2, "--seed", 1007, "--width", 160, "--height", 128)
            self.assertEqual(result["episodes"], json.loads((replay / "evaluation.json").read_text())["episodes"])
            (resumed / "final/vecnormalize.pkl").write_bytes((first / "initial/vecnormalize.pkl").read_bytes())
            failed = run("evaluate.py", "--checkpoint", resumed / "final", "--output-dir", root / "bad",
                         "--episodes", 1, ok=False)
            self.assertIn("digest mismatch", failed.stderr)
            self.assertFalse((root / "bad/evaluation.json").exists())


if __name__ == "__main__":
    unittest.main()
