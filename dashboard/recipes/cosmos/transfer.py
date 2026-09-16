"""Feed genuine SDG images into pinned Cosmos-Transfer2.5 inference."""
import argparse
import json
from pathlib import Path
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input-dir", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()
    import imageio.v2 as imageio
    import numpy as np
    source, output = Path(args.input_dir), Path(args.output_dir)
    manifest = json.loads((source / "dataset-manifest.json").read_text())
    output.mkdir(parents=True, exist_ok=True)
    controls = output / "controls"
    controls.mkdir(exist_ok=True)
    for kind, paths in manifest["modalities"].items():
        if not paths:
            raise ValueError(f"Missing modality {kind}")
        with imageio.get_writer(controls / f"{kind}.mp4", fps=16, codec="libx264") as writer:
            for filename in paths:
                if kind == "depth":
                    depth = np.squeeze(np.load(source / filename))
                    # Fixed 0–5 m visualization, never relabelled as metric depth.
                    pixels = (np.clip(np.nan_to_num(depth, nan=5, posinf=5), 0, 5) / 5 * 255).astype("uint8")
                    pixels = np.repeat(pixels[..., None], 3, axis=-1)
                else:
                    pixels = imageio.imread(source / filename)[..., :3]
                writer.append_data(pixels)
    spec = {"name": "sdg-transfer", "prompt": args.prompt, "seed": args.seed,
            "video_path": str(controls / "rgb.mp4"),
            "depth": {"input_control": str(controls / "depth.mp4"), "control_weight": 1.0}}
    config = output / "transfer.json"
    config.write_text(json.dumps(spec, indent=2))
    subprocess.run([sys.executable, "/opt/cosmos/examples/inference.py", "-i", str(config),
                    "-o", str(output / "generated")], cwd="/opt/cosmos", check=True)
    videos = sorted(str(p.relative_to(output)) for p in (output / "generated").rglob("*.mp4") if p.stat().st_size)
    if not videos:
        raise ValueError("Cosmos completed without generated video")
    (output / "dataset-manifest.json").write_text(json.dumps({
        "schemaVersion": 1, "generator": "Cosmos-Transfer2.5", "seed": args.seed,
        "sourceCommit": "0033b77a9e41e74f9d8d0b9cf80e0ecf94b3533b",
        "inputManifest": manifest, "videos": videos,
        "depthControlEncoding": "0–5 m clipped uint8 video",
        "limitations": "Visual augmentation only; no inferred robot actions or success labels",
    }, indent=2))


if __name__ == "__main__":
    main()
