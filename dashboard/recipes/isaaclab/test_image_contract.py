"""No-GPU build check for the dashboard's fixed non-root workload identity."""
import os
from pathlib import Path
import subprocess
import unittest


class ImageContractTests(unittest.TestCase):
    def test_fixed_workload_identity_can_start_both_recipe_clis(self):
        self.assertEqual(os.getuid(), 1000, "run this regression as the actual workload UID")
        self.assertEqual(os.getgid(), 1000, "run this regression as the actual workload GID")
        python = Path("/isaac-sim/python.sh")
        self.assertTrue(os.access(python, os.R_OK | os.X_OK), "workload must read and execute python.sh")
        asset = Path("/opt/workshop/src/workshop/robots/usd/so_arm101_flat.usd")
        with asset.open("rb") as stream:
            self.assertTrue(stream.read(1), "baked robot asset must be readable")
        for recipe, required in (
            ("train", ["--task", "Workshop-SO101-Reach-v0", "--output-dir", "/tmp/image-contract"]),
            ("play", ["--checkpoint", "/tmp/image-contract/model.pt"]),
        ):
            # Required arguments precede --help because AppLauncher probes the
            # parser while registering flags. Help does not start SimulationApp.
            with self.subTest(recipe=recipe):
                result = subprocess.run(
                    [str(python), f"/opt/recipes/isaaclab/{recipe}.py", *required, "--help"],
                    capture_output=True, text=True, timeout=45)
                self.assertEqual(result.returncode, 0, result.stderr[-2000:])
                self.assertIn("--headless", result.stdout)
                self.assertIn("--enable_cameras", result.stdout)


if __name__ == "__main__":
    unittest.main()
