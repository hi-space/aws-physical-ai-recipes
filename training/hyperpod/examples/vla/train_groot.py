"""GR00T Fine-tuning on SageMaker HyperPod with MLflow tracking.

Wraps Isaac-GR00T's launch_finetune.py with MLflow integration.

Usage:
  python train_groot.py \
    --dataset-path /fsx/datasets/groot/demo_data \
    --embodiment-tag OXE_DROID_RELATIVE_EEF_RELATIVE_JOINT \
    --output-dir /fsx/checkpoints/vla/groot-demo_data \
    --max-steps 2000
"""

import argparse
import os
import subprocess
import sys
from pathlib import Path


def parse_args():
    parser = argparse.ArgumentParser(description="GR00T fine-tuning with MLflow")
    parser.add_argument("--dataset-path", type=str, required=True)
    parser.add_argument("--embodiment-tag", type=str, required=True)
    parser.add_argument("--base-model-path", type=str, default="nvidia/GR00T-N1.7-3B")
    parser.add_argument("--output-dir", type=str, required=True)
    parser.add_argument("--max-steps", type=int, default=2000)
    parser.add_argument("--global-batch-size", type=int, default=2)
    parser.add_argument("--save-steps", type=int, default=2000)
    parser.add_argument("--save-total-limit", type=int, default=5)
    parser.add_argument("--num-gpus", type=int, default=1)
    parser.add_argument("--experiment", type=str, default="groot-finetune")
    parser.add_argument("--gradient-accumulation-steps", type=int, default=2)
    parser.add_argument("--dataloader-num-workers", type=int, default=2)
    return parser.parse_args()


def setup_mlflow(args):
    """Initialize MLflow tracking on rank 0 only."""
    rank = int(os.environ.get("RANK", os.environ.get("LOCAL_RANK", 0)))
    if rank != 0:
        return False

    tracking_uri = os.environ.get("MLFLOW_TRACKING_URI")
    if not tracking_uri:
        print("[MLflow] MLFLOW_TRACKING_URI not set. Skipping MLflow tracking.")
        return False

    try:
        import mlflow
        mlflow.set_tracking_uri(tracking_uri)
        mlflow.set_experiment(args.experiment)
        mlflow.start_run(run_name=f"groot-{Path(args.dataset_path).name}")
        mlflow.log_params({
            "dataset_path": args.dataset_path,
            "embodiment_tag": args.embodiment_tag,
            "base_model": args.base_model_path,
            "max_steps": args.max_steps,
            "global_batch_size": args.global_batch_size,
            "num_gpus": args.num_gpus,
        })
        return True
    except Exception as e:
        print(f"[MLflow] Failed to initialize: {e}")
        return False


def main():
    args = parse_args()
    os.makedirs(args.output_dir, exist_ok=True)

    mlflow_active = setup_mlflow(args)

    gr00t_home = os.environ.get("GR00T_HOME", "/fsx/scratch/Isaac-GR00T")
    launch_script = os.path.join(gr00t_home, "gr00t/experiment/launch_finetune.py")
    python_bin = sys.executable

    cmd = [
        python_bin, launch_script,
        "--base-model-path", args.base_model_path,
        "--dataset-path", args.dataset_path,
        "--embodiment-tag", args.embodiment_tag,
        "--num-gpus", str(args.num_gpus),
        "--output-dir", args.output_dir,
        "--save-total-limit", str(args.save_total_limit),
        "--save-steps", str(args.save_steps),
        "--max-steps", str(args.max_steps),
        "--no-use-wandb",
        "--global-batch-size", str(args.global_batch_size),
        "--gradient-accumulation-steps", str(args.gradient_accumulation_steps),
        "--dataloader-num-workers", str(args.dataloader_num_workers),
    ]

    print(f"Launching: {' '.join(cmd)}")
    result = subprocess.run(cmd, cwd=gr00t_home)

    if mlflow_active:
        import mlflow
        if result.returncode == 0:
            mlflow.log_metric("training_success", 1)
        else:
            mlflow.log_metric("training_success", 0)
        mlflow.end_run()

    sys.exit(result.returncode)


if __name__ == "__main__":
    main()
