"""Cosmos 3 on genuine Replicator SDG frames via the pinned cosmos-framework inference CLI.

Two modes share one image:
  transfer     Cosmos3-Nano video2video with the SDG depth pass as control video (frame-aligned augmentation).
  image2video  Cosmos3-Edge animates the first SDG RGB frame from a prompt (Edge rejects transfer hints upstream).

Outputs are visual data only: no robot actions or success labels are inferred.
"""
import argparse
import json
import os
import re
import shlex
import subprocess
import sys
from pathlib import Path

SOURCE_COMMIT = "c23e51f2f157ae3e51cfcd86ebfb5464850894f2"
DEFAULT_RUNNER = f"{sys.executable} -m cosmos_framework.scripts.inference --parallelism-preset=latency"
CONTROL_FPS = 16
DEPTH_MAX_METRES = 5.0
DEFAULT_I2V_FRAMES = 93
# Upstream chunk default is 93 frames (121 in the depth cookbook); never exceed the cookbook value.
MAX_FRAMES_PER_CHUNK = 121
ASPECT_RATIOS = {"16,9": 16 / 9, "4,3": 4 / 3, "1,1": 1.0, "3,4": 3 / 4, "9,16": 9 / 16}
TRANSFER_MODELS = ("Cosmos3-Nano", "Cosmos3-Super")
MODES = {"transfer": "video2video", "image2video": "image2video"}


PROJECT_RUN_LAYOUT = re.compile(r"^(?P<root>/fsx/checkpoints/projects/[^/]+)/runs/[^/]+/attempts/\d+/[^/]+/?$")


def hf_cache_dir(output: Path, environ=os.environ) -> Path:
    """Where cosmos-framework downloads its ~30 GB checkpoints.

    An explicit HF_HOME wins. Otherwise a dashboard project run (``<root>/runs/<id>/attempts/<n>/<task>``)
    caches under ``<root>/cache/hf`` on FSx: shared across runs, outside the published output, and off the
    HyperPod node's 100 GB root disk where a container-layer download evicts the pod. Anything else uses /tmp/hf.
    """
    if environ.get("HF_HOME"):
        return Path(environ["HF_HOME"])
    match = PROJECT_RUN_LAYOUT.match(str(output))
    return Path(match.group("root")) / "cache" / "hf" if match else Path("/tmp/hf")


def aspect_ratio(width: int, height: int) -> str:
    ratio = width / height
    return min(ASPECT_RATIOS, key=lambda key: abs(ASPECT_RATIOS[key] - ratio))


def load_manifest(source: Path) -> dict:
    manifest = json.loads((source / "dataset-manifest.json").read_text())
    for kind, paths in manifest["modalities"].items():
        if not paths:
            raise ValueError(f"Missing modality {kind}")
    return manifest


def encode_controls(source: Path, manifest: dict, controls: Path) -> dict:
    """Encode every SDG modality as a 16 fps control video; depth uses a fixed 0–5 m visualization."""
    import imageio.v2 as imageio
    import numpy as np
    videos = {}
    for kind, files in manifest["modalities"].items():
        target = controls / f"{kind}.mp4"
        with imageio.get_writer(target, fps=CONTROL_FPS, codec="libx264") as writer:
            for filename in files:
                if kind == "depth":
                    depth = np.squeeze(np.load(source / filename))
                    depth = np.nan_to_num(depth, nan=DEPTH_MAX_METRES, posinf=DEPTH_MAX_METRES)
                    pixels = (np.clip(depth, 0, DEPTH_MAX_METRES) / DEPTH_MAX_METRES * 255).astype("uint8")
                    pixels = np.repeat(pixels[..., None], 3, axis=-1)
                else:
                    pixels = imageio.imread(source / filename)[..., :3]
                writer.append_data(pixels)
        videos[kind] = target
    return videos


def reference_frame(source: Path, manifest: dict, controls: Path) -> Path:
    import imageio.v2 as imageio
    target = controls / "reference.png"
    imageio.imwrite(target, imageio.imread(source / manifest["modalities"]["rgb"][0])[..., :3])
    return target


def build_spec(args, manifest: dict, controls: Path) -> dict:
    spec = {"name": f"sdg-{args.mode}", "model_mode": MODES[args.mode], "prompt": args.prompt, "seed": args.seed,
            "resolution": args.resolution, "aspect_ratio": aspect_ratio(manifest["width"], manifest["height"]),
            "fps": CONTROL_FPS}
    if args.mode == "transfer":
        frames = int(manifest["frames"])
        if args.num_frames is not None and args.num_frames != frames:
            raise ValueError(f"transfer output must stay aligned with the {frames} SDG frames, got --num-frames {args.num_frames}")
        spec.update({
            "vision_path": str(controls / "rgb.mp4"), "num_frames": frames,
            "num_video_frames_per_chunk": min(frames, MAX_FRAMES_PER_CHUNK), "num_conditional_frames": 1,
            "guidance": 3.0, "control_guidance": args.control_guidance,
            "negative_metadata_mode": "none", "emphasize_control_in_prompt": False,
            "depth": {"control_path": str(controls / "depth.mp4"), "weight": 1.0},
        })
    else:
        spec.update({"vision_path": str(controls / "reference.png"),
                     "num_frames": DEFAULT_I2V_FRAMES if args.num_frames is None else args.num_frames})
    return spec


def run_inference(runner: str, spec_path: Path, generated: Path, model: str, seed: int, guardrails: bool = True) -> None:
    # cosmos-framework enables its text/video content guardrails by default, which downloads the gated
    # nvidia/Cosmos-Guardrail1 checkpoint (the HF token owner must have accepted its license once).
    command = [*shlex.split(runner), *([] if guardrails else ["--no-guardrails"]),
               "-i", str(spec_path), "-o", str(generated), "--checkpoint-path", model, "--seed", str(seed)]
    print("Running:", " ".join(shlex.quote(part) for part in command), flush=True)
    subprocess.run(command, check=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--mode", choices=sorted(MODES), required=True)
    parser.add_argument("--model", required=True, help="cosmos-framework checkpoint id, e.g. Cosmos3-Edge or Cosmos3-Nano")
    parser.add_argument("--input-dir", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--resolution", default="480", help="Cosmos 3 resolution tier: 256, 480 or 720")
    parser.add_argument("--num-frames", type=int, default=None,
                        help="image2video output length (default 93); transfer always matches the SDG frame count")
    parser.add_argument("--control-guidance", type=float, default=1.5)
    parser.add_argument("--guardrails", choices=("on", "off"), default="on",
                        help="'off' passes --no-guardrails to cosmos-framework (skips the gated nvidia/Cosmos-Guardrail1 download)")
    parser.add_argument("--runner", default=DEFAULT_RUNNER, help="inference command prefix (tests substitute a stub)")
    args = parser.parse_args(argv)
    if args.mode == "transfer" and args.model not in TRANSFER_MODELS:
        raise ValueError(f"{args.model} does not support transfer hints; use one of {TRANSFER_MODELS}")

    source, output = Path(args.input_dir), Path(args.output_dir)
    cache = hf_cache_dir(output)
    cache.mkdir(parents=True, exist_ok=True)
    os.environ["HF_HOME"] = str(cache)  # inherited by the cosmos-framework subprocess
    manifest = load_manifest(source)
    controls = output / "controls"
    controls.mkdir(parents=True, exist_ok=True)
    if args.mode == "transfer":
        encode_controls(source, manifest, controls)
    else:
        reference_frame(source, manifest, controls)
    spec = build_spec(args, manifest, controls)
    spec_path = output / "spec.json"
    spec_path.write_text(json.dumps(spec, indent=2))
    generated = output / "generated"
    run_inference(args.runner, spec_path, generated, args.model, args.seed, guardrails=args.guardrails == "on")

    videos = sorted(str(p.relative_to(output)) for p in generated.rglob("vision.mp4") if p.stat().st_size)
    if not videos:
        raise ValueError("Cosmos completed without generated video")
    result = {
        "schemaVersion": 1, "generator": f"{args.model} {MODES[args.mode]}", "model": args.model, "mode": args.mode,
        "seed": args.seed, "sourceCommit": SOURCE_COMMIT, "spec": spec, "inputManifest": manifest, "videos": videos,
        "guardrails": args.guardrails == "on", "hfCache": str(cache),
        "limitations": "Visual augmentation only; no inferred robot actions or success labels",
    }
    if args.mode == "transfer":
        result["depthControlEncoding"] = "0–5 m clipped uint8 video"
        result["frameAlignment"] = "one output frame per SDG frame"
    else:
        result["frameAlignment"] = "generated motion; only the first frame comes from SDG"
    (output / "dataset-manifest.json").write_text(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
