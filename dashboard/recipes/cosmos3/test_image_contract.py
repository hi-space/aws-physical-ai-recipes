"""Image contract: the adapter's spec JSON must load through cosmos-framework's own sample schema.

Runs only inside the Cosmos 3 image (``cosmos_framework`` importable); skipped elsewhere. No GPU or weights
are needed because ``OmniSampleOverrides.from_files`` validates the JSON without instantiating the model.
Field names are ``extra="forbid"`` upstream, so a renamed key (e.g. ``control_weight`` vs ``weight``) is a
hard failure here instead of a runtime crash after a 30 GB checkpoint download.

    docker run --rm -v "$PWD/dashboard/recipes:/opt/recipes:ro" <cosmos3-image> \
        python -m unittest /opt/recipes/cosmos3/test_image_contract.py
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import generate  # noqa: E402
from test_generate import STUB, make_sdg  # noqa: E402

try:
    from cosmos_framework.inference.args import OmniSampleOverrides
except ImportError:  # pragma: no cover - host machines without the image
    OmniSampleOverrides = None


@unittest.skipIf(OmniSampleOverrides is None, "cosmos_framework not installed; run inside the Cosmos 3 image")
class Cosmos3SpecContract(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="cosmos3-contract-"))
        stub = self.tmp / "stub.py"
        stub.write_text(STUB.replace("{fail}", "no"))
        self.runner = f"{sys.executable} {stub}"
        self.source = self.tmp / "sdg"
        make_sdg(self.source, frames=93, width=640, height=480)

    def spec_for(self, *extra) -> Path:
        out = self.tmp / extra[1]
        generate.main(["--input-dir", str(self.source), "--output-dir", str(out), "--prompt", "A robot arm on a sunlit bench.",
                       "--seed", "11", "--runner", self.runner, *extra])
        return out / "spec.json"

    def test_transfer_spec_loads_with_depth_hint(self):
        spec = self.spec_for("--mode", "transfer", "--model", "Cosmos3-Nano", "--resolution", "480", "--control-guidance", "1.5")
        loaded = OmniSampleOverrides.from_files([spec])
        self.assertEqual(len(loaded), 1)
        dumped = loaded[0].model_dump(exclude_none=True, mode="json")
        self.assertEqual(dumped["model_mode"], "video2video")
        self.assertEqual(dumped["depth"]["weight"], 1.0)
        self.assertTrue(Path(dumped["depth"]["control_path"]).exists())
        self.assertEqual(dumped["num_frames"], 93)
        self.assertEqual(dumped["control_guidance"], 1.5)

    def test_image2video_spec_loads(self):
        spec = self.spec_for("--mode", "image2video", "--model", "Cosmos3-Edge", "--resolution", "480", "--num-frames", "93")
        dumped = OmniSampleOverrides.from_files([spec])[0].model_dump(exclude_none=True, mode="json")
        self.assertEqual(dumped["model_mode"], "image2video")
        self.assertNotIn("depth", dumped)
        self.assertTrue(Path(dumped["vision_path"]).exists())

    def test_unknown_hint_key_is_rejected_upstream(self):
        spec = self.spec_for("--mode", "transfer", "--model", "Cosmos3-Nano")
        bad = json.loads(spec.read_text())
        bad["depth"]["control_weight"] = 1.0
        bad_path = spec.with_name("spec-bad.json")
        bad_path.write_text(json.dumps(bad))
        with self.assertRaises(Exception):
            OmniSampleOverrides.from_files([bad_path])


if __name__ == "__main__":
    unittest.main()
