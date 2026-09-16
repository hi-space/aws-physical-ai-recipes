"""Run official OpenPI JAX training with a real LeRobot data config and normalization."""
import argparse
import dataclasses
import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile

SOURCE = Path("/opt/openpi")


def load_script(name):
    spec = importlib.util.spec_from_file_location(f"recipe_openpi_{name}", SOURCE / "scripts" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--dataset-root", required=True)
    parser.add_argument("--repo-id", default="physical-intelligence/libero")
    parser.add_argument("--config", choices=["pi0_libero", "pi0_libero_low_mem_finetune", "pi05_libero"], default="pi0_libero_low_mem_finetune")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--steps", type=int, default=1000)
    parser.add_argument("--batch-size", type=int, default=4)
    parser.add_argument("--save-interval", type=int, default=100)
    parser.add_argument("--resume", default="", help="previous output root with checkpoints/config/run")
    args = parser.parse_args()
    output = Path(args.output_dir).resolve()
    output.mkdir(parents=True, exist_ok=True)
    # Inputs/cache must not appear in published output (publisher rejects escaping symlinks).
    scratch_directory = tempfile.TemporaryDirectory(prefix="openpi-")
    scratch = Path(scratch_directory.name)
    # LeRobot resolves HF_LEROBOT_HOME / repo_id.
    local_dataset = scratch / "data" / args.repo_id
    local_dataset.parent.mkdir(parents=True, exist_ok=True)
    local_dataset.symlink_to(Path(args.dataset_root).resolve(), target_is_directory=True)
    os.environ["HF_LEROBOT_HOME"] = str(scratch / "data")
    os.environ["OPENPI_DATA_HOME"] = str(scratch / "model-cache")
    import openpi.training.config as configs
    cfg = configs.get_config(args.config)
    cfg = dataclasses.replace(cfg, exp_name="run", seed=args.seed, num_train_steps=args.steps,
                              batch_size=args.batch_size, save_interval=args.save_interval,
                              num_workers=2, wandb_enabled=False, resume=bool(args.resume),
                              checkpoint_base_dir=str(output / "checkpoints"),
                              assets_base_dir=str(output / "assets"),
                              data=dataclasses.replace(cfg.data, repo_id=args.repo_id))
    if args.resume:
        previous = Path(args.resume).resolve()
        if previous == output:
            raise ValueError("resume into a new run output")
        shutil.copytree(previous / "checkpoints", output / "checkpoints")
        shutil.copytree(previous / "assets", output / "assets")
    else:
        # compute_norm_stats.main resolves config by name. Bind the concrete run config.
        original = configs.get_config
        configs.get_config = lambda _name: cfg
        try:
            load_script("compute_norm_stats").main(args.config)
        finally:
            configs.get_config = original
    load_script("train").main(cfg)
    (output / "training.json").write_text(json.dumps({
        "sourceCommit": "215abfb217dbac7d5f1273282331b9b1866c0479", "config": args.config,
        "seed": args.seed, "steps": args.steps, "repoId": args.repo_id,
        "checkpointDirectory": str(cfg.checkpoint_dir.relative_to(output)), "evaluationType": "training_only",
    }, indent=2))
    scratch_directory.cleanup()


if __name__ == "__main__":
    main()
