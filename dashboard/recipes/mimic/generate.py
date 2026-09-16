"""Official Isaac Lab Mimic annotation/generation with HDF5 output validation."""
import argparse
import json
from pathlib import Path
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input-file", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--task", default="Isaac-Stack-Cube-Franka-IK-Rel-Mimic-v0")
    parser.add_argument("--trials", type=int, default=10)
    parser.add_argument("--num-envs", type=int, default=1)
    args = parser.parse_args()
    output = Path(args.output_dir)
    output.mkdir(parents=True, exist_ok=True)
    scripts = Path("/workspace/isaaclab/scripts/imitation_learning/isaaclab_mimic")
    annotated, generated = output / "annotated.hdf5", output / "generated.hdf5"
    subprocess.run([sys.executable, str(scripts / "annotate_demos.py"), "--headless", "--auto",
                    "--task", args.task, "--input_file", args.input_file, "--output_file", str(annotated)], check=True)
    subprocess.run([sys.executable, str(scripts / "generate_dataset.py"), "--headless", "--enable_cameras",
                    "--task", args.task, "--input_file", str(annotated), "--output_file", str(generated),
                    "--num_envs", str(args.num_envs), "--generation_num_trials", str(args.trials)], check=True)
    import h5py
    with h5py.File(generated, "r") as data:
        demos = list(data["data"].keys())
        if not demos or any("actions" not in data["data"][name] or not len(data["data"][name]["actions"]) for name in demos):
            raise ValueError("Mimic produced no usable action demonstrations")
    (output / "dataset-manifest.json").write_text(json.dumps({
        "schemaVersion": 1, "format": "isaaclab-hdf5", "task": args.task, "episodeCount": len(demos),
        "requestedTrials": args.trials, "dataset": "generated.hdf5",
        "source": "IsaacLab v2.3.0 scripts/imitation_learning/isaaclab_mimic",
    }, indent=2))


if __name__ == "__main__":
    main()
