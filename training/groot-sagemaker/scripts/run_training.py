#!/usr/bin/env python3
"""GR00T SageMaker Training Job 실행 스크립트 (SO-101 디폴트).

파이프라인 없이 SageMaker Training Job을 직접 실행합니다.
개발/디버깅 시 또는 간단한 실행에 사용합니다.
프로덕션 환경에서는 pipeline/run_pipeline.py 사용을 권장합니다.

사용법:
    # SO-101 + S3 채널 (검증 표준 100 step):
    python scripts/run_training.py \\
        --dataset-s3-uri s3://my-bucket/datasets/leisaac-pick-orange

    # SO-101 + HF 직접 다운 + N1.7:
    python scripts/run_training.py \\
        --hf-dataset-id LightwheelAI/leisaac-pick-orange \\
        --hf-token ssm:/groot/hf-token \\
        --groot-version n1.7

    # 본격 학습 (6000 steps):
    python scripts/run_training.py \\
        --dataset-s3-uri s3://my-bucket/datasets/leisaac-pick-orange \\
        --max-steps 6000 --save-steps 2000
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
    region = args.region or aws_cfg.get("region", "us-east-1")

    # ECR 이미지 URI: --groot-version 지정 시 :n1.6 / :n1.7 태그 사용
    if args.training_image_uri:
        training_image_uri = args.training_image_uri
    else:
        base_uri = ecr_cfg.get("training_uri", "")
        if args.groot_version:
            # :latest → :n1.6 / :n1.7로 교체
            if ":" in base_uri:
                training_image_uri = base_uri.rsplit(":", 1)[0] + f":{args.groot_version}"
            else:
                training_image_uri = f"{base_uri}:{args.groot_version}"
        else:
            training_image_uri = base_uri

    # 데이터 입력: --dataset-s3-uri (S3 채널) 또는 --hf-dataset-id (HF 직접 다운)
    if not args.dataset_s3_uri and not args.hf_dataset_id:
        print("오류: --dataset-s3-uri 또는 --hf-dataset-id 중 하나가 필요합니다.")
        sys.exit(1)
    if args.dataset_s3_uri and args.hf_dataset_id:
        print("오류: --dataset-s3-uri와 --hf-dataset-id는 동시 지정 불가.")
        sys.exit(1)

    for name, value in [
        ("역할 ARN (--role-arn)", role_arn),
        ("버킷 (--bucket)", bucket),
        ("학습 이미지 URI (--training-image-uri)", training_image_uri),
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
        "max_steps": str(args.max_steps),
        "global_batch_size": str(args.global_batch_size),
        "save_steps": str(args.save_steps),
        "num_gpus": str(args.num_gpus),
    }
    if args.groot_version:
        hyperparameters["groot_version"] = args.groot_version
    if args.hf_dataset_id:
        hyperparameters["hf_dataset_id"] = args.hf_dataset_id
    if args.hf_token:
        # SSM 참조도 그대로 통과
        hyperparameters["hf_token"] = args.hf_token

    estimator_kwargs = dict(
        image_uri=training_image_uri,
        role=role_arn,
        instance_type=args.instance_type,
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
    print(f"  인스턴스:        {args.instance_type}")
    print(f"  GR00T 버전:      {args.groot_version or '(빌드 디폴트)'}")
    print(f"  학습 이미지:     {training_image_uri}")

    if args.dataset_s3_uri:
        inputs = {"dataset": TrainingInput(s3_data=args.dataset_s3_uri)}
        print(f"  데이터셋:        {args.dataset_s3_uri} (S3 채널)")
    else:
        # SageMaker는 빈 InputDataConfig를 거부하므로 None으로 fit 호출
        inputs = None
        print(f"  데이터셋:        HF/{args.hf_dataset_id} (컨테이너 내 다운로드)")

    try:
        estimator.fit(inputs=inputs, wait=not args.no_wait)
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
        description="GR00T SageMaker Training Job 실행 (SO-101 디폴트)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
예시:
  # SO-101 + leisaac-pick-orange + N1.6, S3 채널 (검증 표준 100 step):
  python scripts/run_training.py \\
      --dataset-s3-uri s3://my-bucket/datasets/leisaac-pick-orange

  # SO-101 + leisaac-pick-orange, HF 직접 다운 + N1.7:
  python scripts/run_training.py \\
      --hf-dataset-id LightwheelAI/leisaac-pick-orange \\
      --hf-token ssm:/groot/hf-token \\
      --groot-version n1.7

  # 본격 학습 (6000 steps):
  python scripts/run_training.py \\
      --dataset-s3-uri s3://my-bucket/datasets/leisaac-pick-orange \\
      --max-steps 6000 --save-steps 2000
        """,
    )
    parser.add_argument("--embodiment-tag", default="NEW_EMBODIMENT",
                        help="로봇 embodiment 식별자 (기본 NEW_EMBODIMENT)")

    src = parser.add_mutually_exclusive_group()
    src.add_argument("--dataset-s3-uri", default="",
                     help="데이터셋 S3 URI (SM_CHANNEL_DATASET으로 주입)")
    src.add_argument("--hf-dataset-id", default="",
                     help="HuggingFace 데이터셋 ID (예: LightwheelAI/leisaac-pick-orange). 컨테이너 내부에서 다운로드")

    parser.add_argument("--hf-token", default="",
                        help="HuggingFace 토큰. 'ssm:/groot/hf-token' 형식이면 컨테이너가 SSM에서 읽음")
    parser.add_argument("--groot-version", choices=["n1.6", "n1.7"], default=None,
                        help="ECR 이미지 태그 선택 (:n1.6 / :n1.7)")
    parser.add_argument("--bucket", default=aws_cfg.get("bucket_name", ""),
                        help="S3 버킷 이름")
    parser.add_argument("--region", default=aws_cfg.get("region", "us-east-1"),
                        help="AWS 리전")
    parser.add_argument("--role-arn", default=aws_cfg.get("role_arn", ""),
                        help="SageMaker 실행 역할 ARN")
    parser.add_argument("--training-image-uri", default="",
                        help="학습 컨테이너 ECR URI 직접 지정 (--groot-version과 무관)")
    parser.add_argument("--instance-type",
                        default=train_cfg.get("instance_type", "ml.g5.2xlarge"),
                        help="학습 인스턴스 타입 (기본 ml.g5.2xlarge — SO-101 단일 GPU 검증용)")
    parser.add_argument("--max-steps", type=int,
                        default=int(train_cfg.get("max_steps", 100)),
                        help="최대 학습 스텝 (기본 100 — 검증용)")
    parser.add_argument("--save-steps", type=int,
                        default=int(train_cfg.get("save_steps", 50)),
                        help="체크포인트 저장 간격 (기본 50)")
    parser.add_argument("--global-batch-size", type=int,
                        default=int(train_cfg.get("global_batch_size", 32)),
                        help="글로벌 배치 크기")
    parser.add_argument("--num-gpus", type=int,
                        default=int(train_cfg.get("num_gpus", 1)),
                        help="GPU 수 (기본 1 — ml.g5.2xlarge는 단일 GPU)")
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
