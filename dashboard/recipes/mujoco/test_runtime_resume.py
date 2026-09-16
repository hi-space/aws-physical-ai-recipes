"""Run with the updated recipes mounted into the cached CPU MuJoCo image."""
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from runtime_resume import runtime_resume_bundle

TASK = "Workshop-SO101-Reach-MuJoCo-v0"


class RuntimeBundleSelection(unittest.TestCase):
    def fixture(self, output):
        root = output / ".pai-resume/replica-0/checkpoint-0" / ("a" * 64)
        root.mkdir(parents=True)
        receipt = {"version": 1, "path": str(output), "manifestHash": root.name, "publicationId": "b" * 64,
                   "source": {"workflowId": "run", "task": "train", "attempt": 1, "epoch": "old"},
                   "target": {"workflowId": "run", "task": "train", "attempt": 2, "epoch": "new"}}
        (root / ".pai-restore-receipt.json").write_text(json.dumps(receipt))
        return root

    def bundle(self, path, steps, updates):
        path.mkdir(parents=True)
        (path / "model.zip").write_bytes(b"model")
        (path / "vecnormalize.pkl").write_bytes(b"normalization")
        (path / "manifest.json").write_text(json.dumps({
            "schemaVersion": 1, "algorithm": "PPO", "task": TASK, "timesteps": steps, "updates": updates,
            "sha256": {name: hashlib.sha256((path / name).read_bytes()).hexdigest()
                       for name in ("model.zip", "vecnormalize.pkl")},
        }))

    def test_latest_complete_optimizer_update_wins_and_corruption_fails(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            root = self.fixture(output)
            self.bundle(root / "checkpoints/step-000000000128", 128, 10)
            self.bundle(root / "final", 128, 20)
            self.bundle(root / ".final.partial", 256, 40)
            with patch.dict(os.environ, {"PAI_RESUME_CHECKPOINTS": json.dumps({str(output): str(root)})}):
                self.assertEqual(runtime_resume_bundle(output, TASK), root / "final")
                (root / "final/vecnormalize.pkl").write_bytes(b"wrong")
                with self.assertRaisesRegex(ValueError, "digest mismatch"):
                    runtime_resume_bundle(output, TASK)

    def test_mapping_cannot_escape_output_or_silently_ignore_missing_receipt(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            root = self.fixture(output)
            with patch.dict(os.environ, {"PAI_RESUME_CHECKPOINTS": json.dumps({str(output): "/etc"})}):
                with self.assertRaises(ValueError):
                    runtime_resume_bundle(output, TASK)
            (root / ".pai-restore-receipt.json").unlink()
            with patch.dict(os.environ, {"PAI_RESUME_CHECKPOINTS": json.dumps({str(output): str(root)})}):
                with self.assertRaises(FileNotFoundError):
                    runtime_resume_bundle(output, TASK)


if __name__ == "__main__":
    unittest.main()
