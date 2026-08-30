#!/usr/bin/env python3
"""GR00T SageMaker Training Job 실행 스크립트 (SO-101 디폴트).

파이프라인 없이 SageMaker Training Job을 직접 실행합니다.
개발/디버깅 시 또는 간단한 실행에 사용합니다.
프로덕션 환경에서는 notebooks/07_sagemaker_pipeline.ipynb 사용을 권장합니다.

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

DOMAIN_ROOT = Path(__file__).resolve().parents[2]      # groot/
TRAINING_ROOT = Path(__file__).resolve().parents[1]    # groot/training/
CONFIG_PATH = DOMAIN_ROOT / "config.yaml"


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
    mlflow_cfg = config.get("mlflow", {})

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

    use_spot = args.use_spot if args.use_spot is not None else train_cfg.get("use_spot", False)
    max_wait = train_cfg.get("max_wait_seconds", 86400) if use_spot else None

    session = sagemaker.Session(
        boto_session=boto3.Session(region_name=region)
    )

    hyperparameters = {
        "embodiment_tag": args.embodiment_tag,
        "max_steps": str(args.max_steps),
        "global_batch_size": str(args.global_batch_size),
        "save_steps": str(args.save_steps),
    }
    if args.num_gpus is not None:
        hyperparameters["num_gpus"] = str(args.num_gpus)
    if args.groot_version:
        hyperparameters["groot_version"] = args.groot_version
    if args.hf_dataset_id:
        hyperparameters["hf_dataset_id"] = args.hf_dataset_id
    if args.hf_token:
        # SSM 참조도 그대로 통과
        hyperparameters["hf_token"] = args.hf_token

    # Script Mode: train.py를 컨테이너에 런타임에 주입 (Docker 재빌드 없이 수정 반영)
    train_source_dir = str(TRAINING_ROOT / "container")

    # HF Trainer가 stdout으로 출력하는 dict 로그를 SageMaker CloudWatch metric으로 발행
    # 예: {'loss': 0.63, 'grad_norm': 1.2, 'learning_rate': 5e-5, 'epoch': 0.01}
    # 평가 단계: {'eval_loss': 0.55, 'eval_runtime': 1.2, ...}
    metric_definitions = [
        {"Name": "train:loss",          "Regex": r"'loss':\s*([0-9.eE+-]+)"},
        {"Name": "train:grad_norm",     "Regex": r"'grad_norm':\s*([0-9.eE+-]+)"},
        {"Name": "train:learning_rate", "Regex": r"'learning_rate':\s*([0-9.eE+-]+)"},
        {"Name": "train:epoch",         "Regex": r"'epoch':\s*([0-9.eE+-]+)"},
        {"Name": "eval:loss",           "Regex": r"'eval_loss':\s*([0-9.eE+-]+)"},
        {"Name": "eval:runtime",        "Regex": r"'eval_runtime':\s*([0-9.eE+-]+)"},
    ]

    # MLflow 환경변수: tracking server ARN이 config.yaml에 있으면 자동 주입.
    # HF Trainer는 mlflow 패키지 + MLFLOW_TRACKING_URI를 감지하면
    # MLflowCallback을 활성화하여 metric/param/artifact를 자동 로깅.
    container_env = {}
    mlflow_arn = args.mlflow_arn or mlflow_cfg.get("tracking_server_arn", "")
    if mlflow_arn:
        container_env["MLFLOW_TRACKING_URI"] = mlflow_arn
        container_env["MLFLOW_EXPERIMENT_NAME"] = (
            args.mlflow_experiment or mlflow_cfg.get("experiment_name", "groot-sm-finetune")
        )
        container_env["HF_MLFLOW_LOG_ARTIFACTS"] = "true"
        print(f"MLflow 활성화: {mlflow_arn}")

    # Job name 을 미리 생성해 checkpoint_s3_uri 와 동일한 식별자를 공유시킨다.
    # 실행마다 unique 하므로 동일 embodiment 로 여러 번 학습해도 경로가 충돌하지 않는다.
    job_name = sagemaker.utils.name_from_base("groot-finetune")
    checkpoint_s3_uri = f"s3://{bucket}/checkpoints/{job_name}"

    # FSx용 비압축 export: 학습 종료 후 train.py가 SM_MODEL_DIR을 이 prefix로 sync한다.
    # (별도 ProcessingStep 없이 소스에서 직접 업로드 → IsaacSim이 FSx로 바로 로드)
    model_prefix = (config.get("model", {}).get("s3_prefix", "models/groot-sm") or "models/groot-sm").strip("/")
    hyperparameters["export_s3_uri"] = f"s3://{bucket}/{model_prefix}/{job_name}"

    estimator_kwargs = dict(
        image_uri=training_image_uri,
        role=role_arn,
        entry_point="train.py",
        source_dir=train_source_dir,
        instance_type=args.instance_type,
        instance_count=1,
        output_path=f"s3://{bucket}/output",
        checkpoint_s3_uri=checkpoint_s3_uri,
        hyperparameters=hyperparameters,
        metric_definitions=metric_definitions,
        sagemaker_session=session,
    )
    if container_env:
        estimator_kwargs["environment"] = container_env

    print(f"체크포인트 S3 경로:  {checkpoint_s3_uri}")

    if use_spot:
        estimator_kwargs.update(
            use_spot_instances=True,
            max_wait=max_wait,
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
        estimator.fit(inputs=inputs, job_name=job_name, wait=not args.no_wait)
    except Exception:
        log_url = (
            f"https://{region}.console.aws.amazon.com/cloudwatch/home"
            f"?region={region}#logsV2:log-groups/log-group/"
            f"%2Faws%2Fsagemaker%2FTrainingJobs/log-events/{job_name}"
        )
        print(f"\nCloudWatch 로그: {log_url}")
        raise

    print(f"\n작업 시작/완료!")
    print(f"  작업 이름:       {job_name}")
    if not args.no_wait:
        model_artifacts = estimator.model_data
        print(f"  모델 아티팩트:   {model_artifacts}")
        print(f"\n다음 단계:")
        print(f"  · 압축된 model.tar.gz입니다. FSx용 압축 해제 export는 notebooks/07_sagemaker_pipeline.ipynb")
        print(f"    (ExportModelForFsx 스텝)에서 자동 수행됩니다.")
    else:
        print(f"  학습 중... 완료 후 model.tar.gz는 s3://<bucket>/output/{job_name}/output/ 에 생성됩니다.")

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
                        default=train_cfg.get("instance_type", "ml.g6e.12xlarge"),
                        help="학습 인스턴스 타입 (기본 ml.g6e.12xlarge — L40S 4-GPU)")
    parser.add_argument("--max-steps", type=int,
                        default=int(train_cfg.get("max_steps", 100)),
                        help="최대 학습 스텝 (기본 100 — 검증용)")
    parser.add_argument("--save-steps", type=int,
                        default=int(train_cfg.get("save_steps", 50)),
                        help="체크포인트 저장 간격 (기본 50)")
    parser.add_argument("--global-batch-size", type=int,
                        default=int(train_cfg.get("global_batch_size", 32)),
                        help="글로벌 배치 크기")
    _cfg_num_gpus = train_cfg.get("num_gpus")
    parser.add_argument("--num-gpus", type=int,
                        default=int(_cfg_num_gpus) if _cfg_num_gpus else None,
                        help="사용할 GPU 수 (미지정 시 인스턴스의 모든 GPU 자동 감지)")
    parser.add_argument("--use-spot", dest="use_spot", action="store_true", default=None,
                        help="Spot Instance 사용")
    parser.add_argument("--no-spot", dest="use_spot", action="store_false",
                        help="Spot Instance 비활성화")
    parser.add_argument("--no-wait", action="store_true",
                        help="학습 완료 대기 없이 즉시 반환")
    parser.add_argument("--mlflow-arn",
                        default=config.get("mlflow", {}).get("tracking_server_arn", ""),
                        help="SageMaker MLflow tracking server ARN (config.yaml의 mlflow.tracking_server_arn 우선)")
    parser.add_argument("--mlflow-experiment",
                        default=config.get("mlflow", {}).get("experiment_name", "groot-sm-finetune"),
                        help="MLflow experiment 이름 (기본: groot-sm-finetune)")

    args = parser.parse_args()

    launch_training_job(args, config)


if __name__ == "__main__":
    main()
