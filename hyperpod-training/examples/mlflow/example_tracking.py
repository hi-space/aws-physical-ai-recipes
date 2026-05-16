"""MLflow 기록 통합 예시 — RL과 VLA 모두 포함.

Usage:
  export MLFLOW_TRACKING_URI=<CDK output>
  python example_tracking.py
"""
import os

import mlflow

TRACKING_URI = os.environ["MLFLOW_TRACKING_URI"]
mlflow.set_tracking_uri(TRACKING_URI)


def log_rl_training(experiment_name: str, env: str, total_steps: int):
    """RL 학습 메트릭 기록 패턴."""
    mlflow.set_experiment(experiment_name)

    with mlflow.start_run():
        mlflow.log_param("env", env)

        for step in range(0, total_steps, 1000):
            reward = 50.0 + step * 0.01
            mlflow.log_metric("reward", reward, step=step)
            mlflow.log_metric("episode_length", 200, step=step)


def log_vla_training(experiment_name: str, model: str, dataset: str, epochs: int):
    """VLA 학습 메트릭 기록 패턴."""
    mlflow.set_experiment(experiment_name)

    with mlflow.start_run():
        mlflow.log_params({"model": model, "dataset": dataset})

        for epoch in range(epochs):
            loss = 2.0 / (epoch + 1)
            mlflow.log_metric("loss", loss, step=epoch)


if __name__ == "__main__":
    log_rl_training("rl-demo", "Isaac-Cartpole-v0", 10000)
    log_vla_training("vla-demo", "GR00T-N1.6-3B", "aloha", 50)
    print("Done. Check SageMaker Studio > MLflow UI.")
