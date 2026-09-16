"""MLflow lifecycle and real TensorBoard scalars; errors propagate when enabled."""
from contextlib import contextmanager
import math
import os
from pathlib import Path


@contextmanager
def tracked(output, params):
    if not os.environ.get("MLFLOW_TRACKING_URI"):
        yield
        return
    import mlflow

    mlflow.set_tracking_uri(os.environ["MLFLOW_TRACKING_URI"])
    mlflow.set_experiment(os.environ.get("MLFLOW_EXPERIMENT_NAME", "physical-ai"))
    with mlflow.start_run(run_name=os.environ.get("MLFLOW_RUN_NAME", Path(output).name)):
        mlflow.log_params(params)
        yield
        # RSL-RL writes actual reward/loss scalars here; no synthetic success metric.
        from tensorboard.backend.event_processing.event_accumulator import EventAccumulator
        for path in Path(output).rglob("events.out.tfevents.*"):
            accumulator = EventAccumulator(str(path), size_guidance={"scalars": 0})
            accumulator.Reload()
            for tag in accumulator.Tags()["scalars"]:
                for event in accumulator.Scalars(tag):
                    if math.isfinite(event.value):
                        mlflow.log_metric(tag, event.value, step=event.step)
        for path in Path(output).glob("*.json"):
            mlflow.log_artifact(str(path))
