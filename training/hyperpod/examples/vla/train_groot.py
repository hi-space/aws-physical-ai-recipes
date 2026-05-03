"""GR00T-N1.7 Fine-tuning on SageMaker HyperPod.

Wraps Isaac-GR00T's official fine-tuning pipeline with HyperPod integration
(MLflow tracking, FSx paths, SLURM-aware distributed training).

Requires: nvcr.io/nvidia/gr00t/gr00t-core:1.7.0 container (gr00t package pre-installed).

Usage:
  torchrun --nproc_per_node=4 train_groot.py \
    --dataset-path /fsx/datasets/groot/aloha \
    --embodiment-tag aloha \
    --data-config default \
    --output-dir /fsx/checkpoints/vla/groot-aloha \
    --max-steps 5000
"""

import argparse
import os
import sys
from pathlib import Path

import mlflow


def parse_args():
    parser = argparse.ArgumentParser(description="GR00T-N1.7 fine-tuning for HyperPod")
    parser.add_argument("--dataset-path", type=str, required=True, help="Path to LeRobot v2 dataset")
    parser.add_argument(
        "--embodiment-tag",
        type=str,
        required=True,
        help="Embodiment tag for the robot (e.g., aloha, xarm)",
    )
    parser.add_argument(
        "--data-config",
        type=str,
        default="default",
        help="Data config name for dataset processing",
    )
    parser.add_argument("--output-dir", type=str, required=True, help="Checkpoint output directory")
    parser.add_argument("--max-steps", type=int, default=5000, help="Total training steps")
    parser.add_argument("--batch-size", type=int, default=32, help="Per-device batch size")
    parser.add_argument("--learning-rate", type=float, default=2e-5, help="Learning rate")
    parser.add_argument("--save-steps", type=int, default=500, help="Save checkpoint every N steps")
    parser.add_argument("--experiment", type=str, default="groot-n1.7-finetune", help="Experiment name")
    parser.add_argument("--resume", type=str, default=None, help="Resume from checkpoint path")
    parser.add_argument("--tune-llm", action="store_true", default=True, help="Fine-tune LLM layers")
    parser.add_argument("--tune-diffusion", action="store_true", default=True, help="Fine-tune diffusion head")
    parser.add_argument("--no-tune-visual", action="store_true", help="Freeze vision encoder")
    parser.add_argument("--state-dropout", type=float, default=0.3, help="State dropout probability")
    return parser.parse_args()


def setup_mlflow(args):
    """Initialize MLflow tracking on rank 0 only."""
    rank = int(os.environ.get("RANK", 0))
    if rank != 0:
        return False

    tracking_uri = os.environ.get("MLFLOW_TRACKING_URI")
    if not tracking_uri:
        print("[MLflow] MLFLOW_TRACKING_URI not set. Skipping MLflow tracking.")
        return False

    mlflow.set_tracking_uri(tracking_uri)
    mlflow.set_experiment(args.experiment)
    mlflow.start_run(run_name=f"groot-{Path(args.dataset_path).name}")
    mlflow.log_params(
        {
            "dataset_path": args.dataset_path,
            "embodiment_tag": args.embodiment_tag,
            "data_config": args.data_config,
            "max_steps": args.max_steps,
            "batch_size": args.batch_size,
            "learning_rate": args.learning_rate,
            "tune_llm": args.tune_llm,
            "tune_diffusion": args.tune_diffusion,
            "state_dropout": args.state_dropout,
        }
    )
    return True


def main():
    args = parse_args()

    os.environ["WANDB_DISABLED"] = "true"

    os.makedirs(args.output_dir, exist_ok=True)

    mlflow_active = setup_mlflow(args)

    from gr00t.core.runner import TrainingRunner

    runner = TrainingRunner(
        dataset_path=args.dataset_path,
        embodiment_tag=args.embodiment_tag,
        data_config=args.data_config,
        output_dir=args.output_dir,
        max_steps=args.max_steps,
        per_device_train_batch_size=args.batch_size,
        learning_rate=args.learning_rate,
        save_steps=args.save_steps,
        tune_llm=args.tune_llm,
        tune_visual=not args.no_tune_visual,
        tune_diffusion_model=args.tune_diffusion,
        state_dropout_prob=args.state_dropout,
        resume_from_checkpoint=args.resume,
    )

    runner.train()

    rank = int(os.environ.get("RANK", 0))
    if rank == 0:
        if mlflow_active:
            mlflow.end_run()
        print(f"Training complete. Checkpoints saved to {args.output_dir}")


if __name__ == "__main__":
    main()
