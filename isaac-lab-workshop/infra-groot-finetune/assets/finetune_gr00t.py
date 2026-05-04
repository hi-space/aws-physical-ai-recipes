#!/usr/bin/env python3
"""
Wrapper script for GR00T N1.7 fine-tuning via launch_finetune.py.
Maps environment variables to CLI arguments for AWS Batch compatibility.
"""

import os
import sys
import subprocess
import logging
from pathlib import Path

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler("/workspace/finetune_gr00t.log"),
    ],
)
logger = logging.getLogger(__name__)


def build_finetune_args():
    """Build CLI arguments for launch_finetune.py from environment variables."""
    dataset_dir = os.getenv("DATASET_LOCAL_DIR", "/workspace/train")
    output_dir = os.getenv("OUTPUT_DIR", "/workspace/checkpoints")
    base_model = os.getenv("BASE_MODEL_PATH", "nvidia/GR00T-N1.7-3B")
    embodiment_tag = os.getenv("EMBODIMENT_TAG", "new_embodiment")

    max_steps = os.getenv("MAX_STEPS", "10000")
    save_steps = os.getenv("SAVE_STEPS", "2000")
    num_gpus = os.getenv("NUM_GPUS", "1")
    batch_size = os.getenv("BATCH_SIZE", "64")
    learning_rate = os.getenv("LEARNING_RATE", "1e-4")

    tune_llm = os.getenv("TUNE_LLM", "false").lower() == "true"
    tune_visual = os.getenv("TUNE_VISUAL", "false").lower() == "true"
    tune_projector = os.getenv("TUNE_PROJECTOR", "true").lower() == "true"
    tune_diffusion = os.getenv("TUNE_DIFFUSION_MODEL", "true").lower() == "true"

    weight_decay = os.getenv("WEIGHT_DECAY", "1e-5")
    warmup_ratio = os.getenv("WARMUP_RATIO", "0.05")
    dataloader_num_workers = os.getenv("DATALOADER_NUM_WORKERS", "8")
    use_wandb = os.getenv("REPORT_TO", "tensorboard") == "wandb"

    modality_config_path = os.getenv("MODALITY_CONFIG_PATH", "")

    args = [
        "--base-model-path", base_model,
        "--dataset-path", dataset_dir,
        "--embodiment-tag", embodiment_tag,
        "--output-dir", output_dir,
        "--max-steps", max_steps,
        "--save-steps", save_steps,
        "--num-gpus", num_gpus,
        "--global-batch-size", batch_size,
        "--learning-rate", learning_rate,
        "--weight-decay", weight_decay,
        "--warmup-ratio", warmup_ratio,
        "--dataloader-num-workers", dataloader_num_workers,
    ]

    if tune_llm:
        args.append("--tune-llm")
    else:
        args.append("--no-tune-llm")

    if tune_visual:
        args.append("--tune-visual")
    else:
        args.append("--no-tune-visual")

    if tune_projector:
        args.append("--tune-projector")
    else:
        args.append("--no-tune-projector")

    if tune_diffusion:
        args.append("--tune-diffusion-model")
    else:
        args.append("--no-tune-diffusion-model")

    if use_wandb:
        args.append("--use-wandb")

    if modality_config_path:
        args.extend(["--modality-config-path", modality_config_path])

    return args


def main():
    logger.info("Starting GR00T N1.7 fine-tuning...")

    # If RESUME=false, clear stale checkpoints from output_dir to prevent auto-resume
    resume = os.getenv("RESUME", "true").lower()
    output_dir = os.getenv("OUTPUT_DIR", "/workspace/checkpoints")
    if resume == "false" and Path(output_dir).exists():
        import glob
        stale_checkpoints = glob.glob(os.path.join(output_dir, "checkpoint-*"))
        if stale_checkpoints:
            import shutil
            for cp in stale_checkpoints:
                logger.info(f"RESUME=false: removing stale checkpoint {cp}")
                shutil.rmtree(cp, ignore_errors=True)

    args = build_finetune_args()
    launch_script = "/workspace/gr00t/experiment/launch_finetune.py"

    if not Path(launch_script).exists():
        logger.error(f"launch_finetune.py not found at {launch_script}")
        sys.exit(1)

    cmd = [sys.executable, launch_script] + args
    logger.info(f"Running: {' '.join(cmd)}")

    result = subprocess.run(cmd, env=os.environ.copy())

    if result.returncode != 0:
        logger.error(f"Fine-tuning failed with exit code {result.returncode}")
        sys.exit(result.returncode)

    logger.info("GR00T N1.7 fine-tuning completed successfully!")


if __name__ == "__main__":
    main()
