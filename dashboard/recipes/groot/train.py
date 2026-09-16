"""Adapter for pinned GR00T N1.6.1 launch_finetune, including Trainer state resume."""
import argparse
import json
import os
from pathlib import Path
import runpy
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tracking import tracked


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--resume", default="")
    parser.add_argument("--output-dir", required=True)
    args, upstream_args = parser.parse_known_args()
    output = Path(args.output_dir)
    output.mkdir(parents=True, exist_ok=True)
    if args.resume and not (Path(args.resume) / "trainer_state.json").is_file():
        raise ValueError("resume must reference a complete trusted Transformers checkpoint directory")
    from gr00t.experiment import experiment
    from transformers import TrainerCallback

    original_run, original_train = experiment.run, experiment.Gr00tTrainer.train

    class Metrics(TrainerCallback):
        def on_log(self, _args, state, control, logs=None, **_kwargs):
            if os.environ.get("MLFLOW_TRACKING_URI") and state.is_world_process_zero:
                import mlflow
                for key, value in (logs or {}).items():
                    if isinstance(value, (float, int)):
                        mlflow.log_metric(key, value, step=state.global_step)

    def train(trainer, *positional, **kwargs):
        # Upstream N1.6.1 always passes True, even on a fresh empty directory.
        # Pass an explicit requested source (optimizer/scheduler/RNG), or None.
        kwargs["resume_from_checkpoint"] = args.resume or None
        trainer.args.save_only_model = False
        trainer.add_callback(Metrics())
        return original_train(trainer, *positional, **kwargs)

    def run(config):
        config.data.seed = args.seed
        config.training.experiment_name = None
        return original_run(config)

    experiment.Gr00tTrainer.train, experiment.run = train, run
    sys.argv = ["launch_finetune", "--output-dir", str(output), "--no-use-wandb", *upstream_args]
    try:
        with tracked(output, {"seed": args.seed, "resume": args.resume, "algorithm": "GR00T-N1.6.1"}):
            runpy.run_module("gr00t.experiment.launch_finetune", run_name="__main__")
            (output / "training.json").write_text(json.dumps({
                "seed": args.seed, "resume": args.resume,
                "sourceCommit": "5dc80c4afd726b34faad1d8f7e007a13b34e4c88",
                "evaluationType": "training_only",
            }, indent=2))
    finally:
        experiment.Gr00tTrainer.train, experiment.run = original_train, original_run


if __name__ == "__main__":
    main()
