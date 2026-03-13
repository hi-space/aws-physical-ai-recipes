"""SageMaker training entrypoint for GR00T-N1.6 fine-tuning.

Parses SageMaker environment variables, builds the subprocess command
to call Isaac-GR00T's launch_finetune.py, and copies model artifacts
to SM_MODEL_DIR after training completes.
"""

import os
import shutil
import subprocess
import sys


def parse_sagemaker_env() -> dict:
    """Parse SageMaker environment variables into a configuration dict.

    Returns:
        Dict with keys: model_dir, dataset_dir, output_dir, embodiment_tag,
        max_steps, global_batch_size, save_steps, num_gpus, wandb_api_key.
    """
    return {
        "model_dir": os.environ.get("SM_CHANNEL_MODEL", "/opt/ml/input/data/model"),
        "dataset_dir": os.environ.get("SM_CHANNEL_DATASET", "/opt/ml/input/data/dataset"),
        "output_dir": os.environ.get("SM_MODEL_DIR", "/opt/ml/model"),
        "embodiment_tag": os.environ.get("SM_HP_EMBODIMENT_TAG", "new_embodiment"),
        "max_steps": os.environ.get("SM_HP_MAX_STEPS", "10000"),
        "global_batch_size": os.environ.get("SM_HP_GLOBAL_BATCH_SIZE", "32"),
        "save_steps": os.environ.get("SM_HP_SAVE_STEPS", "2000"),
        "num_gpus": os.environ.get("SM_HP_NUM_GPUS", "1"),
        "wandb_api_key": os.environ.get("SM_HP_WANDB_API_KEY", ""),
    }


def build_training_command(env_config: dict) -> list[str]:
    """Build the subprocess command list to call Isaac-GR00T's launch_finetune.py.

    Args:
        env_config: Dict returned by parse_sagemaker_env().

    Returns:
        List of command-line arguments for subprocess.
    """
    # Use a training-specific output dir to separate from SM_MODEL_DIR
    training_output_dir = os.path.join(env_config["output_dir"], "training_output")

    cmd = [
        sys.executable,
        "gr00t/experiment/launch_finetune.py",
        "--base-model-path", env_config["model_dir"],
        "--dataset-path", env_config["dataset_dir"],
        "--embodiment-tag", env_config["embodiment_tag"],
        "--num-gpus", env_config["num_gpus"],
        "--output-dir", training_output_dir,
        "--max-steps", env_config["max_steps"],
        "--global-batch-size", env_config["global_batch_size"],
        "--save-steps", env_config["save_steps"],
    ]

    if env_config.get("wandb_api_key"):
        cmd.append("--use-wandb")

    return cmd


def copy_model_artifacts(source_dir: str, dest_dir: str) -> None:
    """Copy model artifacts from training output to SM_MODEL_DIR.

    Args:
        source_dir: Directory containing trained model artifacts.
        dest_dir: SM_MODEL_DIR destination.
    """
    if not os.path.isdir(source_dir):
        print(f"Warning: training output directory not found: {source_dir}")
        return

    for item in os.listdir(source_dir):
        src = os.path.join(source_dir, item)
        dst = os.path.join(dest_dir, item)
        if os.path.isdir(src):
            shutil.copytree(src, dst, dirs_exist_ok=True)
        else:
            shutil.copy2(src, dst)

    print(f"Model artifacts copied from {source_dir} to {dest_dir}")


def main() -> None:
    """Main entrypoint: parse env, run training, copy artifacts."""
    env_config = parse_sagemaker_env()

    # Set wandb API key in environment if provided
    if env_config.get("wandb_api_key"):
        os.environ["WANDB_API_KEY"] = env_config["wandb_api_key"]

    cmd = build_training_command(env_config)
    print(f"Running training command: {' '.join(cmd)}")

    result = subprocess.run(cmd, check=False)

    if result.returncode != 0:
        print(f"Training failed with return code {result.returncode}", file=sys.stderr)
        sys.exit(result.returncode)

    # Copy artifacts from training output to SM_MODEL_DIR
    training_output_dir = os.path.join(env_config["output_dir"], "training_output")
    copy_model_artifacts(training_output_dir, env_config["output_dir"])

    print("Training completed successfully.")


if __name__ == "__main__":
    main()
