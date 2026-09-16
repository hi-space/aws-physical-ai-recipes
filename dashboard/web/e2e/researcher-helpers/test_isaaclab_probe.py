"""CPU-only verifier tests. Fixtures are not evidence of live GPU training."""
import copy
import json
from pathlib import Path
import tempfile
import unittest

import torch
import yaml
from torch.utils.tensorboard import SummaryWriter

from isaaclab_probe import category, checkpoint, clean, training_proof


class CheckpointVerifierTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.output = Path(self.temporary.name)
        (self.output / "checkpoints").mkdir()
        torch.manual_seed(42)
        model = torch.nn.Linear(2, 1)
        optimizer = torch.optim.Adam(model.parameters(), lr=0.01)
        for iteration in range(2):
            optimizer.zero_grad()
            loss = (model(torch.ones(4, 2)) - 1).square().mean()
            loss.backward()
            optimizer.step()
            self.saved = {"model_state_dict": model.state_dict(),
                          "optimizer_state_dict": optimizer.state_dict(), "iter": iteration, "infos": None}
            torch.save(self.saved, self.output / f"checkpoints/model_{iteration}.pt")
        torch.save(self.saved, self.output / "model_final.pt")
        (self.output / "training.json").write_text(json.dumps({
            "task": "Workshop-SO101-Reach-v0", "seed": 42, "iterations": 2, "resume": "",
            "checkpoint": "model_final.pt", "evaluationType": "training_only"}))
        # Deliberate wire fixtures for validator unit tests, never live GPU metrics.
        (self.output / "environment.yaml").write_text(yaml.safe_dump({
            "scene": {"num_envs": 32}, "seed": 42, "sim": {"device": "cuda:0"}}))
        (self.output / "agent.yaml").write_text(yaml.safe_dump({
            "seed": 42, "save_interval": 1, "device": "cuda:0", "num_steps_per_env": 24}))
        writer = SummaryWriter(self.output / "checkpoints")
        for step in (0, 1):
            writer.add_scalar("Loss/value_function", 1 / (step + 1), step)
            writer.add_scalar("Loss/surrogate", -0.2 / (step + 1), step)
        writer.close()

    def tearDown(self):
        self.temporary.cleanup()

    def test_real_torch_state_round_trip_and_two_updates(self):
        proof = training_proof(self.output)
        self.assertEqual(proof["first"]["optimizerSteps"]["min"], 1)
        self.assertEqual(proof["final"]["optimizerSteps"]["min"], 2)
        self.assertNotEqual(proof["first"]["modelStateSHA256"], proof["final"]["modelStateSHA256"])
        self.assertEqual(proof["second"]["modelStateSHA256"], proof["final"]["modelStateSHA256"])

    def test_empty_optimizer_cannot_count_as_training(self):
        self.saved["optimizer_state_dict"]["state"] = {}
        torch.save(self.saved, self.output / "model_final.pt")
        with self.assertRaisesRegex(ValueError, "optimizer state"):
            checkpoint(self.output / "model_final.pt")

    def test_nonfinite_model_rejected(self):
        self.saved["model_state_dict"]["weight"].fill_(float("nan"))
        torch.save(self.saved, self.output / "model_final.pt")
        with self.assertRaisesRegex(ValueError, "nonfinite"):
            checkpoint(self.output / "model_final.pt")

    def test_zero_optimizer_step_rejected(self):
        for state in self.saved["optimizer_state_dict"]["state"].values():
            state["step"].zero_()
        torch.save(self.saved, self.output / "model_final.pt")
        with self.assertRaisesRegex(ValueError, "completed an update"):
            checkpoint(self.output / "model_final.pt")

    def test_missing_adam_moments_rejected(self):
        saved = copy.deepcopy(self.saved)
        del next(iter(saved["optimizer_state_dict"]["state"].values()))["exp_avg"]
        torch.save(saved, self.output / "model_final.pt")
        with self.assertRaisesRegex(ValueError, "Adam moments"):
            checkpoint(self.output / "model_final.pt")

    def test_replayed_first_checkpoint_is_not_a_second_iteration(self):
        (self.output / "model_final.pt").write_bytes((self.output / "checkpoints/model_0.pt").read_bytes())
        with self.assertRaisesRegex(ValueError, "did not advance"):
            training_proof(self.output)

    def test_task_mismatch_rejected(self):
        metadata = json.loads((self.output / "training.json").read_text())
        metadata["task"] = "Workshop-SO101-Lift-v0"
        (self.output / "training.json").write_text(json.dumps(metadata))
        with self.assertRaisesRegex(ValueError, "metadata"):
            training_proof(self.output)

    def test_cpu_config_rejected(self):
        (self.output / "environment.yaml").write_text(yaml.safe_dump({
            "scene": {"num_envs": 32}, "seed": 42, "sim": {"device": "cpu"}}))
        with self.assertRaisesRegex(ValueError, "CUDA"):
            training_proof(self.output)

    def test_missing_real_scalar_events_rejected(self):
        for path in (self.output / "checkpoints").glob("events.out.tfevents.*"):
            path.unlink()
        with self.assertRaisesRegex(ValueError, "TensorBoard"):
            training_proof(self.output)

    def test_symlink_checkpoint_rejected(self):
        link = self.output / "link.pt"
        link.symlink_to(self.output / "model_final.pt")
        with self.assertRaisesRegex(ValueError, "regular file"):
            checkpoint(link)

    def test_failure_categories_and_redaction(self):
        self.assertEqual(category("CUDA driver not found"), "gpu-driver-or-memory")
        self.assertEqual(category("USD asset cannot be opened"), "simulator-assets")
        self.assertEqual(category("Permission denied /fsx/output"), "filesystem-permissions")
        self.assertEqual(category("TypeError: unexpected keyword argument"), "image-recipe-compatibility")
        redacted = clean("https://bucket/key?signature=secret bearer bearer-secret token=token-secret")
        self.assertNotIn("secret", redacted)
        self.assertNotIn("https://", redacted)


if __name__ == "__main__":
    unittest.main()
