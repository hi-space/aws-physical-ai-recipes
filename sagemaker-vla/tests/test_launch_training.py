"""Unit tests for scripts/launch_training.py."""

import sys
import os
from unittest.mock import patch, MagicMock

import pytest

# Add project root to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from src.config import TrainingConfig
from scripts.launch_training import launch_training_job


def _make_config(**overrides) -> TrainingConfig:
    """Helper to create a valid TrainingConfig with sensible defaults."""
    defaults = {
        "base_model_s3_uri": "s3://my-bucket/models/groot",
        "dataset_s3_uri": "s3://my-bucket/datasets/lerobot",
        "output_s3_uri": "s3://my-bucket/output/finetuned",
        "instance_type": "ml.p4d.24xlarge",
        "embodiment_tag": "test_robot",
    }
    defaults.update(overrides)
    return TrainingConfig(**defaults)


class TestLaunchTrainingJobValidation:
    """Tests for input validation in launch_training_job."""

    def test_invalid_instance_type_raises_value_error(self):
        config = _make_config(instance_type="ml.t3.medium")
        with pytest.raises(ValueError, match="does not meet the minimum 48GB VRAM"):
            launch_training_job(config, "123.dkr.ecr.us-east-1.amazonaws.com/img:latest", "arn:aws:iam::123:role/R")

    def test_invalid_instance_type_includes_recommendations(self):
        config = _make_config(instance_type="ml.g5.xlarge")
        with pytest.raises(ValueError, match="Recommended instance types"):
            launch_training_job(config, "123.dkr.ecr.us-east-1.amazonaws.com/img:latest", "arn:aws:iam::123:role/R")

    def test_invalid_base_model_s3_uri_raises_value_error(self):
        config = _make_config(base_model_s3_uri="not-an-s3-uri")
        with pytest.raises(ValueError, match="Invalid S3 URI for base_model_s3_uri"):
            launch_training_job(config, "img:latest", "arn:role")

    def test_invalid_dataset_s3_uri_raises_value_error(self):
        config = _make_config(dataset_s3_uri="http://example.com/data")
        with pytest.raises(ValueError, match="Invalid S3 URI for dataset_s3_uri"):
            launch_training_job(config, "img:latest", "arn:role")

    def test_invalid_output_s3_uri_raises_value_error(self):
        config = _make_config(output_s3_uri="")
        with pytest.raises(ValueError, match="Invalid S3 URI for output_s3_uri"):
            launch_training_job(config, "img:latest", "arn:role")

    def test_sagemaker_not_installed_raises_import_error(self):
        """When sagemaker SDK is not available, should raise ImportError."""
        config = _make_config()
        with patch("scripts.launch_training.sagemaker", None):
            with pytest.raises(ImportError, match="sagemaker SDK is required"):
                launch_training_job(config, "img:latest", "arn:role")


class TestLaunchTrainingJobEstimator:
    """Tests for Estimator creation and fit call (mocked sagemaker SDK)."""

    @patch("scripts.launch_training.TrainingInput")
    @patch("scripts.launch_training.Estimator")
    @patch("scripts.launch_training.sagemaker", new_callable=MagicMock)
    def test_estimator_created_with_correct_params(self, mock_sm, mock_estimator_cls, mock_input):
        config = _make_config()
        mock_estimator = MagicMock()
        mock_estimator.latest_training_job.name = "groot-job-001"
        mock_estimator_cls.return_value = mock_estimator

        job_name = launch_training_job(
            config, "123.dkr.ecr.us-east-1.amazonaws.com/img:latest", "arn:aws:iam::123:role/R"
        )

        mock_estimator_cls.assert_called_once()
        call_kwargs = mock_estimator_cls.call_args[1]
        assert call_kwargs["image_uri"] == "123.dkr.ecr.us-east-1.amazonaws.com/img:latest"
        assert call_kwargs["role"] == "arn:aws:iam::123:role/R"
        assert call_kwargs["instance_type"] == "ml.p4d.24xlarge"
        assert call_kwargs["instance_count"] == 1
        assert call_kwargs["output_path"] == "s3://my-bucket/output/finetuned"
        assert job_name == "groot-job-001"

    @patch("scripts.launch_training.TrainingInput")
    @patch("scripts.launch_training.Estimator")
    @patch("scripts.launch_training.sagemaker", new_callable=MagicMock)
    def test_hyperparameters_include_config_fields(self, mock_sm, mock_estimator_cls, mock_input):
        config = _make_config(max_steps=5000, global_batch_size=16, save_steps=500, num_gpus=8)
        mock_estimator = MagicMock()
        mock_estimator.latest_training_job.name = "job-002"
        mock_estimator_cls.return_value = mock_estimator

        launch_training_job(config, "img:latest", "arn:role")

        hp = mock_estimator_cls.call_args[1]["hyperparameters"]
        assert hp["embodiment_tag"] == "test_robot"
        assert hp["max_steps"] == "5000"
        assert hp["global_batch_size"] == "16"
        assert hp["save_steps"] == "500"
        assert hp["num_gpus"] == "8"
        assert "wandb_api_key" not in hp

    @patch("scripts.launch_training.TrainingInput")
    @patch("scripts.launch_training.Estimator")
    @patch("scripts.launch_training.sagemaker", new_callable=MagicMock)
    def test_wandb_key_included_when_provided(self, mock_sm, mock_estimator_cls, mock_input):
        config = _make_config(wandb_api_key="wk-abc123")
        mock_estimator = MagicMock()
        mock_estimator.latest_training_job.name = "job-003"
        mock_estimator_cls.return_value = mock_estimator

        launch_training_job(config, "img:latest", "arn:role")

        hp = mock_estimator_cls.call_args[1]["hyperparameters"]
        assert hp["wandb_api_key"] == "wk-abc123"

    @patch("scripts.launch_training.TrainingInput")
    @patch("scripts.launch_training.Estimator")
    @patch("scripts.launch_training.sagemaker", new_callable=MagicMock)
    def test_s3_input_channels_configured(self, mock_sm, mock_estimator_cls, mock_input):
        config = _make_config()
        mock_estimator = MagicMock()
        mock_estimator.latest_training_job.name = "job-004"
        mock_estimator_cls.return_value = mock_estimator

        launch_training_job(config, "img:latest", "arn:role")

        # Verify fit was called with model and dataset channels
        mock_estimator.fit.assert_called_once()
        fit_kwargs = mock_estimator.fit.call_args[1]
        assert "model" in fit_kwargs["inputs"]
        assert "dataset" in fit_kwargs["inputs"]

    @patch("scripts.launch_training.TrainingInput")
    @patch("scripts.launch_training.Estimator")
    @patch("scripts.launch_training.sagemaker", new_callable=MagicMock)
    def test_failure_prints_cloudwatch_link_and_reraises(self, mock_sm, mock_estimator_cls, mock_input, capsys):
        config = _make_config()
        mock_estimator = MagicMock()
        mock_estimator.fit.side_effect = RuntimeError("Job failed")
        mock_estimator.latest_training_job.name = "failed-job-001"
        mock_session = MagicMock()
        mock_session.boto_region_name = "us-east-1"
        mock_estimator.sagemaker_session = mock_session
        mock_estimator_cls.return_value = mock_estimator

        with pytest.raises(RuntimeError, match="Job failed"):
            launch_training_job(config, "img:latest", "arn:role")

        captured = capsys.readouterr()
        assert "CloudWatch logs" in captured.out
        assert "failed-job-001" in captured.out


class TestMainCLI:
    """Tests for the argparse-based main() function."""

    @patch("scripts.launch_training.launch_training_job")
    def test_main_parses_required_args(self, mock_launch):
        mock_launch.return_value = "cli-job-001"
        test_args = [
            "launch_training.py",
            "--base-model-s3-uri", "s3://bucket/model",
            "--dataset-s3-uri", "s3://bucket/data",
            "--output-s3-uri", "s3://bucket/output",
            "--embodiment-tag", "my_robot",
            "--container-image-uri", "123.dkr.ecr.us-east-1.amazonaws.com/img:latest",
            "--role-arn", "arn:aws:iam::123:role/R",
        ]
        with patch("sys.argv", test_args):
            from scripts.launch_training import main
            main()

        mock_launch.assert_called_once()
        call_kwargs = mock_launch.call_args[1]
        config = call_kwargs["config"]
        assert config.base_model_s3_uri == "s3://bucket/model"
        assert config.instance_type == "ml.p4d.24xlarge"  # default
        assert config.instance_count == 1  # default
        assert call_kwargs["container_image_uri"] == "123.dkr.ecr.us-east-1.amazonaws.com/img:latest"
        assert call_kwargs["role_arn"] == "arn:aws:iam::123:role/R"

    @patch("scripts.launch_training.launch_training_job")
    def test_main_parses_optional_args(self, mock_launch):
        mock_launch.return_value = "cli-job-002"
        test_args = [
            "launch_training.py",
            "--base-model-s3-uri", "s3://b/m",
            "--dataset-s3-uri", "s3://b/d",
            "--output-s3-uri", "s3://b/o",
            "--embodiment-tag", "bot",
            "--container-image-uri", "img:latest",
            "--role-arn", "arn:role",
            "--instance-type", "ml.p5.48xlarge",
            "--instance-count", "2",
            "--max-steps", "5000",
            "--global-batch-size", "16",
            "--save-steps", "500",
            "--num-gpus", "8",
            "--wandb-api-key", "wk-xyz",
        ]
        with patch("sys.argv", test_args):
            from scripts.launch_training import main
            main()

        config = mock_launch.call_args[1]["config"]
        assert config.instance_type == "ml.p5.48xlarge"
        assert config.instance_count == 2
        assert config.max_steps == 5000
        assert config.global_batch_size == 16
        assert config.save_steps == 500
        assert config.num_gpus == 8
        assert config.wandb_api_key == "wk-xyz"
