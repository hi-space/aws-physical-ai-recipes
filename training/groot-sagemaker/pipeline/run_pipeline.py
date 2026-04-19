#!/usr/bin/env python3
"""GR00T-N1.6 SageMaker Pipeline 실행 스크립트.

학습 → 모델 레지스트리 등록의 두 단계로 구성된 파이프라인을 생성하고 실행합니다.

파이프라인 구성:
  1. GR00TFinetune  : SageMaker Training Job (Spot Instance 선택 가능)
  2. RegisterModel  : 완료된 모델을 Model Registry에 등록 (수동 승인 대기)

모델 승인 후 엔드포인트 배포는 scripts/deploy_endpoint.py로 수행합니다.

사용법:
    # 파이프라인 생성 및 실행
    python pipeline/run_pipeline.py \
        --embodiment-tag my_robot \
        --dataset-s3-uri s3://my-bucket/datasets/my-robot

    # 파이프라인 정의만 업서트 (실행하지 않음)
    python pipeline/run_pipeline.py --upsert-only

    # 기존 파이프라인 실행 (재실행)
    python pipeline/run_pipeline.py --start-only
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


def build_pipeline(config: dict, args: argparse.Namespace):
    """SageMaker Pipeline 객체를 생성합니다."""
    try:
        import sagemaker
        from sagemaker.estimator import Estimator
        from sagemaker.inputs import TrainingInput
        from sagemaker.model import Model
        from sagemaker.workflow.parameters import ParameterInteger, ParameterString
        from sagemaker.workflow.pipeline import Pipeline
        from sagemaker.workflow.pipeline_context import PipelineSession
        from sagemaker.workflow.steps import TrainingStep
        from sagemaker.workflow.model_step import ModelStep
    except ImportError:
        print("오류: sagemaker SDK가 설치되지 않았습니다.")
        print("  pip install 'sagemaker<3'")
        sys.exit(1)

    aws_cfg = config.get("aws", {})
    train_cfg = config.get("training", {})
    infer_cfg = config.get("inference", {})
    ecr_cfg = config.get("ecr", {})

    role_arn = args.role_arn or aws_cfg.get("role_arn", "")
    bucket = args.bucket or aws_cfg.get("bucket_name", "")
    region = args.region or aws_cfg.get("region", "ap-northeast-2")
    training_image_uri = args.training_image_uri or ecr_cfg.get("training_uri", "")

    if not role_arn:
        print("오류: SageMaker 실행 역할 ARN이 필요합니다.")
        print("  --role-arn을 지정하거나 infra/deploy_stack.py를 먼저 실행하세요.")
        sys.exit(1)

    if not bucket:
        print("오류: S3 버킷 이름이 필요합니다.")
        print("  --bucket을 지정하거나 infra/deploy_stack.py를 먼저 실행하세요.")
        sys.exit(1)

    if not training_image_uri:
        print("오류: 학습 컨테이너 ECR URI가 필요합니다.")
        print("  --training-image-uri를 지정하거나 scripts/trigger_build.py를 먼저 실행하세요.")
        sys.exit(1)

    sagemaker_session = PipelineSession(
        boto_session=__import__("boto3").Session(region_name=region)
    )

    # -----------------------------------------------------------------------
    # 파이프라인 파라미터 (실행 시 오버라이드 가능)
    # -----------------------------------------------------------------------
    p_embodiment_tag = ParameterString(
        name="EmbodimentTag",
        default_value=args.embodiment_tag,
    )
    p_base_model_s3_uri = ParameterString(
        name="BaseModelS3Uri",
        default_value=args.base_model_s3_uri,
    )
    p_dataset_s3_uri = ParameterString(
        name="DatasetS3Uri",
        default_value=args.dataset_s3_uri,
    )
    p_instance_type = ParameterString(
        name="InstanceType",
        default_value=args.instance_type or train_cfg.get("instance_type", "ml.p4d.24xlarge"),
    )
    p_max_steps = ParameterInteger(
        name="MaxSteps",
        default_value=args.max_steps or train_cfg.get("max_steps", 10000),
    )
    p_global_batch_size = ParameterInteger(
        name="GlobalBatchSize",
        default_value=args.global_batch_size or train_cfg.get("global_batch_size", 32),
    )
    p_num_gpus = ParameterInteger(
        name="NumGpus",
        default_value=args.num_gpus or train_cfg.get("num_gpus", 8),
    )

    # -----------------------------------------------------------------------
    # Step 1: Training Job (Spot Instance)
    # -----------------------------------------------------------------------
    use_spot = args.use_spot if args.use_spot is not None else train_cfg.get("use_spot", True)
    max_wait = train_cfg.get("max_wait_seconds", 86400) if use_spot else None

    # Script Mode: train.py를 런타임에 주입 (Docker 재빌드 없이 스크립트 수정 반영)
    train_source_dir = str(PROJECT_ROOT / "container" / "training")

    estimator_kwargs = dict(
        image_uri=training_image_uri,
        role=role_arn,
        entry_point="train.py",
        source_dir=train_source_dir,
        instance_type=p_instance_type,
        instance_count=1,
        output_path=f"s3://{bucket}/output",
        hyperparameters={
            "embodiment_tag": p_embodiment_tag,
            "max_steps": p_max_steps,
            "global_batch_size": p_global_batch_size,
            "save_steps": str(train_cfg.get("save_steps", 2000)),
            "num_gpus": p_num_gpus,
        },
        sagemaker_session=sagemaker_session,
        environment={
            # wandb 키는 SSM에서 직접 읽도록 설정
            "SM_HP_WANDB_API_KEY": "ssm:/groot/wandb-key",
        },
    )

    if use_spot:
        estimator_kwargs.update(
            use_spot_instances=True,
            max_wait=max_wait,
            checkpoint_s3_uri=f"s3://{bucket}/checkpoints/{args.embodiment_tag}",
        )
        print(f"Spot Instance 학습 활성화 (최대 대기: {max_wait}초)")

    estimator = Estimator(**estimator_kwargs)

    training_step = TrainingStep(
        name="GR00TFinetune",
        estimator=estimator,
        inputs={
            "model": TrainingInput(s3_data=p_base_model_s3_uri),
            "dataset": TrainingInput(s3_data=p_dataset_s3_uri),
        },
    )

    # -----------------------------------------------------------------------
    # Step 2: Model Registry 등록
    # -----------------------------------------------------------------------
    model_package_group = infer_cfg.get("model_package_group", "groot-n16-models")
    inference_image_uri = args.inference_image_uri or ecr_cfg.get("inference_uri", training_image_uri)

    model = Model(
        image_uri=inference_image_uri,
        model_data=training_step.properties.ModelArtifacts.S3ModelArtifacts,
        role=role_arn,
        sagemaker_session=sagemaker_session,
    )

    register_step = ModelStep(
        name="RegisterModel",
        step_args=model.register(
            model_package_group_name=model_package_group,
            approval_status="PendingManualApproval",
            description=f"GR00T-N1.6 파인튜닝 모델 (embodiment: {args.embodiment_tag})",
            customer_metadata_properties={
                "embodiment_tag": args.embodiment_tag,
                "dataset_s3_uri": args.dataset_s3_uri,
            },
        ),
        depends_on=[training_step],
    )

    # -----------------------------------------------------------------------
    # 파이프라인 조립
    # -----------------------------------------------------------------------
    pipeline = Pipeline(
        name="groot-n16-finetuning",
        parameters=[
            p_embodiment_tag,
            p_base_model_s3_uri,
            p_dataset_s3_uri,
            p_instance_type,
            p_max_steps,
            p_global_batch_size,
            p_num_gpus,
        ],
        steps=[training_step, register_step],
        sagemaker_session=sagemaker_session,
    )

    return pipeline


def main() -> None:
    config = load_config()
    aws_cfg = config.get("aws", {})
    train_cfg = config.get("training", {})

    parser = argparse.ArgumentParser(
        description="GR00T-N1.6 SageMaker Pipeline 생성 및 실행",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
예시:
  # 파이프라인 실행 (기본값 사용)
  python pipeline/run_pipeline.py \\
      --embodiment-tag my_robot \\
      --dataset-s3-uri s3://my-bucket/datasets/my-robot

  # Spot Instance 비활성화
  python pipeline/run_pipeline.py \\
      --embodiment-tag my_robot \\
      --dataset-s3-uri s3://my-bucket/datasets/my-robot \\
      --no-spot

  # 파이프라인 정의만 업서트 (실행 안 함)
  python pipeline/run_pipeline.py --embodiment-tag my_robot --upsert-only
        """,
    )

    # 필수 인수
    parser.add_argument("--embodiment-tag", default="NEW_EMBODIMENT",
                        help="로봇 embodiment 식별자 (기본값: NEW_EMBODIMENT)")
    parser.add_argument("--dataset-s3-uri", default="",
                        help="데이터셋 S3 URI (s3://bucket/prefix)")
    parser.add_argument("--base-model-s3-uri",
                        default=f"s3://{aws_cfg.get('bucket_name', 'my-bucket')}/{config.get('model', {}).get('s3_prefix', 'models/groot-n16')}",
                        help="베이스 모델 S3 URI")

    # 선택 인수 (config.yaml 기본값 사용)
    parser.add_argument("--bucket", default=aws_cfg.get("bucket_name", ""),
                        help="S3 버킷 이름")
    parser.add_argument("--region", default=aws_cfg.get("region", "ap-northeast-2"),
                        help="AWS 리전")
    parser.add_argument("--role-arn", default=aws_cfg.get("role_arn", ""),
                        help="SageMaker 실행 역할 ARN")
    parser.add_argument("--training-image-uri", default=config.get("ecr", {}).get("training_uri", ""),
                        help="학습 컨테이너 ECR URI")
    parser.add_argument("--inference-image-uri", default=config.get("ecr", {}).get("inference_uri", ""),
                        help="추론 컨테이너 ECR URI (미지정 시 학습 URI 사용)")
    parser.add_argument("--instance-type", default=train_cfg.get("instance_type", "ml.p4d.24xlarge"),
                        help="학습 인스턴스 타입")
    parser.add_argument("--max-steps", type=int, default=train_cfg.get("max_steps", 10000),
                        help="최대 학습 스텝")
    parser.add_argument("--global-batch-size", type=int, default=train_cfg.get("global_batch_size", 32),
                        help="글로벌 배치 크기")
    parser.add_argument("--num-gpus", type=int, default=train_cfg.get("num_gpus", 8),
                        help="GPU 수")
    parser.add_argument("--use-spot", dest="use_spot", action="store_true", default=None,
                        help="Spot Instance 사용 (기본값: config.yaml의 training.use_spot)")
    parser.add_argument("--no-spot", dest="use_spot", action="store_false",
                        help="Spot Instance 비활성화")
    parser.add_argument("--upsert-only", action="store_true",
                        help="파이프라인 정의만 업서트하고 실행하지 않음")
    parser.add_argument("--start-only", action="store_true",
                        help="파이프라인 업서트 없이 기존 파이프라인만 실행")

    args = parser.parse_args()

    if not args.dataset_s3_uri and not args.upsert_only:
        print("오류: --dataset-s3-uri가 필요합니다.")
        sys.exit(1)

    print("파이프라인 빌드 중...")
    pipeline = build_pipeline(config, args)

    if not args.start_only:
        print("파이프라인 업서트 중 (정의 생성/업데이트)...")
        pipeline.upsert(role_arn=args.role_arn or config.get("aws", {}).get("role_arn", ""))
        print(f"파이프라인 업서트 완료: groot-n16-finetuning")

    if not args.upsert_only:
        print("파이프라인 실행 중...")
        execution = pipeline.start(
            parameters={
                "EmbodimentTag": args.embodiment_tag,
                "DatasetS3Uri": args.dataset_s3_uri,
                "BaseModelS3Uri": args.base_model_s3_uri,
            }
        )
        print(f"\n파이프라인 실행 시작!")
        print(f"  실행 ARN: {execution.arn}")
        print(f"\n진행 상황 확인:")
        print(f"  AWS 콘솔 → SageMaker → Pipelines → groot-n16-finetuning")
        print(f"\n학습 완료 후:")
        print(f"  1. SageMaker → Model Registry → groot-n16-models에서 모델 승인")
        print(f"  2. python scripts/deploy_endpoint.py 로 엔드포인트 배포")


if __name__ == "__main__":
    main()
