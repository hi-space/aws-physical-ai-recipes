"""SageMaker Managed MLflow 사용 예시.

Usage:
  export MLFLOW_TRACKING_URI=<CDK output>
  python example_usage.py
"""
import os

import mlflow

TRACKING_URI = os.environ["MLFLOW_TRACKING_URI"]
mlflow.set_tracking_uri(TRACKING_URI)


def example_rl_logging():
    """RL 학습 중 MLflow 기록 예시."""
    mlflow.set_experiment("rl-cartpole-demo")

    with mlflow.start_run(run_name="ppo-baseline"):
        mlflow.log_params({
            "algorithm": "PPO",
            "env": "Isaac-Cartpole-v0",
            "num_actors": 8,
            "lr": 3e-4,
            "gamma": 0.99,
        })

        for step in range(100):
            mlflow.log_metrics({
                "reward": 50.0 + step * 2,
                "episode_length": 100 + step * 5,
                "policy_loss": 1.0 / (step + 1),
            }, step=step)

    print("RL logging example complete.")


def example_vla_logging():
    """VLA 학습 중 MLflow 기록 예시."""
    mlflow.set_experiment("vla-groot-demo")

    with mlflow.start_run(run_name="groot-aloha-finetune"):
        mlflow.log_params({
            "model": "GR00T-N1.6-3B",
            "dataset": "aloha",
            "epochs": 50,
            "batch_size": 32,
            "lr": 1e-4,
        })

        for epoch in range(50):
            mlflow.log_metrics({
                "loss": 2.0 / (epoch + 1),
                "accuracy": min(0.95, 0.5 + epoch * 0.01),
                "learning_rate": 1e-4 * (0.95 ** epoch),
            }, step=epoch)

    print("VLA logging example complete.")


if __name__ == "__main__":
    example_rl_logging()
    example_vla_logging()
    print("\nMLflow UI에서 확인: SageMaker Studio > MLflow")
