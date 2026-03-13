#!/usr/bin/env python3
"""GR00T-N1.6 단독 SageMaker Training Job 실행 스크립트.

파이프라인 없이 SageMaker Training Job을 직접 실행합니다.
개발/디버깅 시 또는 간단한 실행에 사용합니다.
프로덕션 환경에서는 pipeline/run_pipeline.py 사용을 권장합니다.

사용법:
    python scripts/run_training.py \
        --embodiment-tag my_robot \
        --dataset-s3-uri s3://my-bucket/datasets/my-robot

    # Spot Instance 비활성화 (디버깅용):
    python scripts/run_training.py \
        --embodiment-tag my_robot \
        --dataset-s3-uri s3://my-bucket/datasets/my-robot \
        --no-spot
"""

import argparse
import sys
from pathlib import Path

import yaml

PROJECT_ROOT = Path(__file__).parent.parent
CONFIG_PATH = PROJECT_ROOT / "config.yaml"


def load_config() -> dict:
    if CONFIG_PATH.exists():
        return yaml.safe_load(CONFIG_PATH.read_text(encoding="utf-8"))
    return {}


def launch_training_job(args: argparse.Namespace, config: dict) -> str:
    """SageMaker Training Job을 시작합니다.

    Args:
        args: CLI 인수.
        config: config.yaml 설정.

    Returns:
        학습 작업 이름.
    """
    try:
        import sagemaker
        from sagemaker.estimator import Estimator
        from sagemaker.inputs import TrainingInput
    except ImportError:
        print("오류: sagemaker SDK가 설치되지 않았습니다.")
        print("  pip install sagemaker")
        sys.exit(1)

    import boto3

    aws_cfg = config.get("aws", {})
    train_cfg = config.get("training", {})
    ecr_cfg = config.get("ecr", {})

    role_arn = args.role_arn or aws_cfg.get("role_arn", "")
    bucket = args.bucket or aws_cfg.get("bucket_name", "")
    region = args.region or aws_cfg.get("region", "ap-northeast-2")
    training_image_uri = args.training_image_uri or ecr_cfg.get("training_uri", "")
    base_model_s3_uri = args.base_model_s3_uri
    if not base_model_s3_uri:
        model_prefix = config.get("model", {}).get("s3_prefix", "models/groot-n16")
        base_model_s3_uri = f"s3://{bucket}/{model_prefix}"

    for name, value in [
        ("역할 ARN (--role-arn)", role_arn),
        ("버킷 (--bucket)", bucket),
        ("학습 이미지 URI (--training-image-uri)", training_image_uri),
        ("데이터셋 S3 URI (--dataset-s3-uri)", args.dataset_s3_uri),
    ]:
        if not value:
            print(f"오류: {name}가 필요합니다.")
            print("  infra/deploy_stack.py 및 scripts/trigger_build.py를 먼저 실행하세요.")
            sys.exit(1)

    use_spot = args.use_spot if args.use_spot is not None else train_cfg.get("use_spot", True)
    max_wait = train_cfg.get("max_wait_seconds", 86400) if use_spot else None

    session = sagemaker.Session(
        boto_session=boto3.Session(region_name=region)
    )

    hyperparameters = {
        "embodiment_tag": args.embodiment_tag,
        "max_steps": str(args.max_steps or train_cfg.get("max_steps", 10000)),
        "global_batch_size": str(args.global_batch_size or train_cfg.get("global_batch_size", 32)),
        "save_steps": str(train_cfg.get("save_steps", 2000)),
        "num_gpus": str(train_cfg.get("num_gpus", 8)),
    }

    estimator_kwargs = dict(
        image_uri=training_image_uri,
        role=role_arn,
        instance_type=args.instance_type or train_cfg.get("instance_type", "ml.p4d.24xlarge"),
        instance_count=1,
        output_path=f"s3://{bucket}/output",
        hyperparameters=hyperparameters,
        sagemaker_session=session,
    )

    if use_spot:
        estimator_kwargs.update(
            use_spot_instances=True,
            max_wait=max_wait,
            checkpoint_s3_uri=f"s3://{bucket}/checkpoints/{args.embodiment_tag}",
        )
        print(f"Spot Instance 학습 활성화")

    estimator = Estimator(**estimator_kwargs)

    print(f"SageMaker Training Job 시작 중...")
    print(f"  embodiment_tag:  {args.embodiment_tag}")
    print(f"  인스턴스:        {estimator_kwargs['instance_type']}")
    print(f"  베이스 모델:     {base_model_s3_uri}")
    print(f"  데이터셋:        {args.dataset_s3_uri}")

    try:
        estimator.fit(
            inputs={
                "model": TrainingInput(s3_data=base_model_s3_uri),
                "dataset": TrainingInput(s3_data=args.dataset_s3_uri),
            },
            wait=not args.no_wait,
        )
    except Exception as e:
        job_name = getattr(
            getattr(estimator, "latest_training_job", None), "name", None
        )
        if job_name:
            log_url = (
                f"https://{region}.console.aws.amazon.com/cloudwatch/home"
                f"?region={region}#logsV2:log-groups/log-group/"
                f"%2Faws%2Fsagemaker%2FTrainingJobs/log-events/{job_name}"
            )
            print(f"\nCloudWatch 로그: {log_url}")
        raise

    job_name = estimator.latest_training_job.name
    model_artifacts = estimator.model_data

    print(f"\n학습 완료!")
    print(f"  작업 이름:       {job_name}")
    print(f"  모델 아티팩트:   {model_artifacts}")
    print(f"\n다음 단계:")
    print(f"  python scripts/deploy_endpoint.py --model-s3-uri {model_artifacts}")

    return job_name


def main() -> None:
    config = load_config()
    aws_cfg = config.get("aws", {})
    train_cfg = config.get("training", {})

    parser = argparse.ArgumentParser(
        description="GR00T-N1.6 단독 SageMaker Training Job 실행",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
예시:
  python scripts/run_training.py \\
      --embodiment-tag my_robot \\
      --dataset-s3-uri s3://my-bucket/datasets/my-robot

  # Spot 비활성화 + 바로 반환 (no-wait):
  python scripts/run_training.py \\
      --embodiment-tag my_robot \\
      --dataset-s3-uri s3://my-bucket/datasets/my-robot \\
      --no-spot --no-wait
        """,
    )
    parser.add_argument("--embodiment-tag", default="new_embodiment",
                        help="로봇 embodiment 식별자")
    parser.add_argument("--dataset-s3-uri", default="",
                        help="데이터셋 S3 URI")
    parser.add_argument("--base-model-s3-uri", default="",
                        help="베이스 모델 S3 URI (미지정 시 config.yaml 사용)")
    parser.add_argument("--bucket", default=aws_cfg.get("bucket_name", ""),
                        help="S3 버킷 이름")
    parser.add_argument("--region", default=aws_cfg.get("region", "ap-northeast-2"),
                        help="AWS 리전")
    parser.add_argument("--role-arn", default=aws_cfg.get("role_arn", ""),
                        help="SageMaker 실행 역할 ARN")
    parser.add_argument("--training-image-uri", default=config.get("ecr", {}).get("training_uri", ""),
                        help="학습 컨테이너 ECR URI")
    parser.add_argument("--instance-type", default=train_cfg.get("instance_type", "ml.p4d.24xlarge"),
                        help="학습 인스턴스 타입")
    parser.add_argument("--max-steps", type=int, default=train_cfg.get("max_steps", 10000),
                        help="최대 학습 스텝")
    parser.add_argument("--global-batch-size", type=int, default=train_cfg.get("global_batch_size", 32),
                        help="글로벌 배치 크기")
    parser.add_argument("--use-spot", dest="use_spot", action="store_true", default=None,
                        help="Spot Instance 사용")
    parser.add_argument("--no-spot", dest="use_spot", action="store_false",
                        help="Spot Instance 비활성화")
    parser.add_argument("--no-wait", action="store_true",
                        help="학습 완료 대기 없이 즉시 반환")

    args = parser.parse_args()

    launch_training_job(args, config)


if __name__ == "__main__":
    main()
