"""CPU contract test for the Cosmos 3 adapter: SDG frames → framework spec → published manifest.

The real ``cosmos_framework.scripts.inference`` needs a GPU and tens of GB of weights, so the test swaps
the runner for a stub that records the spec it received and writes a non-empty ``vision.mp4``. What is
verified is everything the adapter owns: control-video encoding, spec construction, output validation,
and the manifest contract the dashboard publishes.
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
import imageio.v2 as imageio

sys.path.insert(0, str(Path(__file__).resolve().parent))
import generate  # noqa: E402

STUB = '''
import json, sys
from pathlib import Path
args = sys.argv[1:]
spec = json.loads(Path(args[args.index("-i") + 1]).read_text())
out = Path(args[args.index("-o") + 1]) / spec["name"]
out.mkdir(parents=True, exist_ok=True)
(out / "vision.mp4").write_bytes(b"\\x00" * 64 if "{fail}" != "yes" else b"")
(out / "sample_args.json").write_text(json.dumps({"argv": args, "spec": spec}))
'''


def make_sdg(source: Path, frames: int = 4, width: int = 64, height: int = 48) -> dict:
    files = {"rgb": [], "depth": [], "segmentation": []}
    (source / "frames").mkdir(parents=True)
    for i in range(frames):
        rgb = np.full((height, width, 4), 80 + i, dtype=np.uint8)
        imageio.imwrite(source / "frames" / f"rgb_{i:04d}.png", rgb)
        depth = np.linspace(0.2, 7.0, width * height, dtype=np.float32).reshape(height, width, 1)
        depth[0, 0, 0] = np.inf
        np.save(source / "frames" / f"distance_to_camera_{i:04d}.npy", depth)
        seg = np.zeros((height, width, 4), dtype=np.uint8)
        seg[..., 1] = 200
        imageio.imwrite(source / "frames" / f"semantic_segmentation_{i:04d}.png", seg)
        files["rgb"].append(f"frames/rgb_{i:04d}.png")
        files["depth"].append(f"frames/distance_to_camera_{i:04d}.npy")
        files["segmentation"].append(f"frames/semantic_segmentation_{i:04d}.png")
    manifest = {"schemaVersion": 1, "generator": "Isaac Sim Replicator BasicWriter", "scene": "/opt/x.usd",
                "seed": 7, "frames": frames, "width": width, "height": height, "modalities": files, "depthUnits": "metres"}
    (source / "dataset-manifest.json").write_text(json.dumps(manifest))
    return manifest


class Cosmos3Adapter(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="cosmos3-test-"))
        self.source = self.tmp / "sdg"
        self.manifest = make_sdg(self.source)
        self.stub = self.tmp / "stub.py"
        self.stub.write_text(STUB.replace("{fail}", "no"))
        self.runner = f"{sys.executable} {self.stub}"

    def run_adapter(self, *extra, runner=None):
        output = self.tmp / "out"
        argv = ["--input-dir", str(self.source), "--output-dir", str(output), "--prompt", "A robot arm on a sunlit bench.",
                "--seed", "11", "--runner", runner or self.runner, *extra]
        generate.main(argv)
        recorded = json.loads(next((output / "generated").rglob("sample_args.json")).read_text())
        return output, recorded["spec"], recorded["argv"], json.loads((output / "dataset-manifest.json").read_text())

    def test_nano_transfer_aligns_depth_control_with_every_sdg_frame(self):
        output, spec, argv, manifest = self.run_adapter("--mode", "transfer", "--model", "Cosmos3-Nano",
                                                        "--resolution", "720", "--control-guidance", "1.5")
        self.assertEqual(spec["model_mode"], "video2video")
        self.assertEqual(spec["prompt"], "A robot arm on a sunlit bench.")
        self.assertEqual(spec["seed"], 11)
        self.assertEqual(spec["resolution"], "720")
        self.assertEqual(spec["aspect_ratio"], "4,3")  # 64x48 SDG frames
        self.assertEqual(spec["num_frames"], self.manifest["frames"])
        self.assertEqual(spec["fps"], 16)
        self.assertEqual(spec["control_guidance"], 1.5)
        self.assertEqual(spec["depth"]["weight"], 1.0)  # framework TransferOverrides field is `weight`
        self.assertEqual(Path(spec["vision_path"]), output / "controls" / "rgb.mp4")
        self.assertEqual(Path(spec["depth"]["control_path"]), output / "controls" / "depth.mp4")
        for name in ("rgb", "depth", "segmentation"):
            frames = imageio.mimread(output / "controls" / f"{name}.mp4")
            self.assertEqual(len(frames), self.manifest["frames"], name)
        depth = imageio.mimread(output / "controls" / "depth.mp4")[0]
        self.assertEqual(depth.shape[-1], 3)
        self.assertEqual(argv[argv.index("--checkpoint-path") + 1], "Cosmos3-Nano")
        self.assertEqual(argv[argv.index("--seed") + 1], "11")
        self.assertEqual(manifest["generator"], "Cosmos3-Nano video2video")
        self.assertEqual(manifest["sourceCommit"], generate.SOURCE_COMMIT)
        self.assertEqual(manifest["videos"], ["generated/sdg-transfer/vision.mp4"])
        self.assertEqual(manifest["inputManifest"], self.manifest)
        self.assertIn("0–5 m", manifest["depthControlEncoding"])
        self.assertIn("no inferred robot actions", manifest["limitations"])
        self.assertEqual(manifest["spec"], spec)

    def test_edge_image_to_video_uses_only_the_first_rgb_frame(self):
        output, spec, argv, manifest = self.run_adapter("--mode", "image2video", "--model", "Cosmos3-Edge",
                                                        "--resolution", "480", "--num-frames", "93")
        self.assertEqual(spec["model_mode"], "image2video")
        self.assertEqual(spec["num_frames"], 93)
        self.assertEqual(spec["resolution"], "480")
        self.assertNotIn("depth", spec)
        self.assertNotIn("control_guidance", spec)
        reference = Path(spec["vision_path"])
        self.assertEqual(reference, output / "controls" / "reference.png")
        self.assertEqual(imageio.imread(reference).shape[:2], (48, 64))
        self.assertFalse((output / "controls" / "depth.mp4").exists())
        self.assertEqual(argv[argv.index("--checkpoint-path") + 1], "Cosmos3-Edge")
        self.assertEqual(manifest["generator"], "Cosmos3-Edge image2video")
        self.assertNotIn("depthControlEncoding", manifest)
        self.assertEqual(manifest["videos"], ["generated/sdg-image2video/vision.mp4"])

    def test_transfer_frame_count_defaults_to_sdg_frames_and_rejects_mismatch(self):
        with self.assertRaises(ValueError):
            self.run_adapter("--mode", "transfer", "--model", "Cosmos3-Nano", "--num-frames", "5")

    def test_edge_rejects_transfer_mode(self):
        with self.assertRaises(ValueError):
            self.run_adapter("--mode", "transfer", "--model", "Cosmos3-Edge")

    def test_missing_modality_and_empty_video_fail_loudly(self):
        self.manifest["modalities"]["depth"] = []
        (self.source / "dataset-manifest.json").write_text(json.dumps(self.manifest))
        with self.assertRaises(ValueError):
            self.run_adapter("--mode", "transfer", "--model", "Cosmos3-Nano")
        self.manifest = make_sdg(self.tmp / "sdg2")
        self.source = self.tmp / "sdg2"
        failing = self.tmp / "fail.py"
        failing.write_text(STUB.replace("{fail}", "yes"))
        with self.assertRaises(ValueError):
            self.run_adapter("--mode", "image2video", "--model", "Cosmos3-Edge", runner=f"{sys.executable} {failing}")

    def test_runner_failure_propagates(self):
        with self.assertRaises(subprocess.CalledProcessError):
            self.run_adapter("--mode", "image2video", "--model", "Cosmos3-Edge", runner=f"{sys.executable} -c 'raise SystemExit(3)'")


if __name__ == "__main__":
    os.environ.setdefault("PYTHONDONTWRITEBYTECODE", "1")
    unittest.main()
