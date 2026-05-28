#!/usr/bin/env python3
"""GR00T-N1.6 SageMaker Pipeline 실행 스크립트.

학습 → 모델 레지스트리 등록 → endpoint 자동 배포의 세 단계로 구성된 파이프라인.

파이프라인 구성:
  1. GR00TFinetune  : SageMaker Training Job (Spot Instance 선택 가능)
  2. RegisterModel  : Model Registry에 Approved 상태로 등록
  3. DeployEndpoint : LambdaStep — 기존 endpoint 정리 + Model/EndpointConfig/Endpoint 생성

Step 2 와 Step 3 는 같은 training artifact 를 사용하는 병렬 흐름입니다
(Registry 기록 vs 실 배포). Endpoint 가 InService 가 되기까지는 5-10 분 더 걸리며,
Lambda 는 create_endpoint API 호출 성공만 확인하고 종료합니다.

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

DOMAIN_ROOT = Path(__file__).resolve().parents[1]      # groot/
TRAINING_ROOT = DOMAIN_ROOT / "training"               # groot/training/
CONFIG_PATH = DOMAIN_ROOT / "config.yaml"


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
        from sagemaker.workflow.lambda_step import LambdaStep
        from sagemaker.lambda_helper import Lambda
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
    region = args.region or aws_cfg.get("region", "us-east-1")
    alias = aws_cfg.get("alias", "") or ""
    suffix = f"-{alias}" if alias else ""
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
    p_dataset_s3_uri = ParameterString(
        name="DatasetS3Uri",
        default_value=args.dataset_s3_uri,
    )
    p_instance_type = ParameterString(
        name="InstanceType",
        default_value=args.instance_type or train_cfg.get("instance_type", "ml.g5.2xlarge"),
    )
    p_max_steps = ParameterInteger(
        name="MaxSteps",
        default_value=args.max_steps or train_cfg.get("max_steps", 6000),
    )
    p_global_batch_size = ParameterInteger(
        name="GlobalBatchSize",
        default_value=args.global_batch_size or train_cfg.get("global_batch_size", 32),
    )
    p_num_gpus = ParameterInteger(
        name="NumGpus",
        default_value=args.num_gpus or train_cfg.get("num_gpus", 1),
    )
    p_endpoint_name = ParameterString(
        name="EndpointName",
        default_value=args.endpoint_name or infer_cfg.get("endpoint_name", f"groot-sm-endpoint{suffix}"),
    )
    p_endpoint_instance_type = ParameterString(
        name="EndpointInstanceType",
        default_value=args.endpoint_instance_type or infer_cfg.get("instance_type", "ml.g5.2xlarge"),
    )

    # -----------------------------------------------------------------------
    # Step 1: Training Job (Spot Instance)
    # -----------------------------------------------------------------------
    use_spot = args.use_spot if args.use_spot is not None else train_cfg.get("use_spot", True)
    max_wait = train_cfg.get("max_wait_seconds", 86400) if use_spot else None

    # Script Mode: train.py를 런타임에 주입 (Docker 재빌드 없이 스크립트 수정 반영)
    train_source_dir = str(TRAINING_ROOT / "container")

    # HF Trainer stdout dict 로그 → CloudWatch metric
    metric_definitions = [
        {"Name": "train:loss",          "Regex": r"'loss':\s*([0-9.eE+-]+)"},
        {"Name": "train:grad_norm",     "Regex": r"'grad_norm':\s*([0-9.eE+-]+)"},
        {"Name": "train:learning_rate", "Regex": r"'learning_rate':\s*([0-9.eE+-]+)"},
        {"Name": "train:epoch",         "Regex": r"'epoch':\s*([0-9.eE+-]+)"},
        {"Name": "eval:loss",           "Regex": r"'eval_loss':\s*([0-9.eE+-]+)"},
        {"Name": "eval:runtime",        "Regex": r"'eval_runtime':\s*([0-9.eE+-]+)"},
    ]

    estimator_kwargs = dict(
        image_uri=training_image_uri,
        role=role_arn,
        entry_point="train.py",
        source_dir=train_source_dir,
        instance_type=p_instance_type,
        instance_count=1,
        output_path=f"s3://{bucket}/output",
        metric_definitions=metric_definitions,
        hyperparameters={
            "embodiment_tag": p_embodiment_tag,
            "max_steps": p_max_steps,
            "global_batch_size": p_global_batch_size,
            "save_steps": str(train_cfg.get("save_steps", 2000)),
            "num_gpus": p_num_gpus,
            **({"hf_dataset_id": args.hf_dataset_id} if args.hf_dataset_id else {}),
            **({"hf_token": args.hf_token} if args.hf_token else {}),
            **({"groot_version": args.groot_version} if args.groot_version else {}),
        },
        sagemaker_session=sagemaker_session,
        environment={
            # wandb 키는 SSM에서 직접 읽도록 설정
            "SM_HP_WANDB_API_KEY": "ssm:/groot/wandb-key",
            # MLflow tracking server (config.yaml의 mlflow.tracking_server_arn).
            # HF Trainer가 mlflow 패키지 + MLFLOW_TRACKING_URI를 감지하면 자동 로깅.
            **({"MLFLOW_TRACKING_URI": config.get("mlflow", {}).get("tracking_server_arn", "")}
               if config.get("mlflow", {}).get("tracking_server_arn") else {}),
            **({"MLFLOW_EXPERIMENT_NAME": config.get("mlflow", {}).get("experiment_name", "groot-sm-finetune")}
               if config.get("mlflow", {}).get("tracking_server_arn") else {}),
            **({"HF_MLFLOW_LOG_ARTIFACTS": "true"}
               if config.get("mlflow", {}).get("tracking_server_arn") else {}),
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

    # dataset 채널은 항상 정의해 둔다. ParameterString 으로 S3 URI 가 늦게 바인딩되므로
    # upsert 시점에 --dataset-s3-uri 가 비어 있어도 콘솔/CLI 실행 시 DatasetS3Uri 파라미터로
    # 채널이 채워진다. (이전엔 inputs=None 으로 박제되어 콘솔 파라미터가 무시되었다.)
    training_inputs = {"dataset": TrainingInput(s3_data=p_dataset_s3_uri)}

    training_step = TrainingStep(
        name="GR00TFinetune",
        estimator=estimator,
        inputs=training_inputs,
    )

    # -----------------------------------------------------------------------
    # Step 2: Model Registry 등록
    # -----------------------------------------------------------------------
    model_package_group = infer_cfg.get("model_package_group", "groot-sm-models")
    inference_image_uri = args.inference_image_uri or ecr_cfg.get("inference_uri", training_image_uri)

    model = Model(
        image_uri=inference_image_uri,
        model_data=training_step.properties.ModelArtifacts.S3ModelArtifacts,
        role=role_arn,
        sagemaker_session=sagemaker_session,
    )

    # AWS는 CustomerMetadataValue가 최소 길이 1을 요구하므로 빈 값은 제외
    customer_metadata = {
        k: v for k, v in {
            "embodiment_tag": args.embodiment_tag,
            "dataset_s3_uri": args.dataset_s3_uri,
            "hf_dataset_id": args.hf_dataset_id,
            "groot_version": args.groot_version or "",
        }.items() if v
    }

    register_step = ModelStep(
        name="RegisterModel",
        step_args=model.register(
            model_package_group_name=model_package_group,
            approval_status="Approved",
            description=f"GR00T-N1.6 파인튜닝 모델 (embodiment: {args.embodiment_tag})",
            customer_metadata_properties=customer_metadata,
        ),
        depends_on=[training_step],
    )

    # -----------------------------------------------------------------------
    # Step 3: Endpoint 자동 배포 (LambdaStep)
    #   기존 endpoint 삭제 → Model/EndpointConfig/Endpoint 생성 atomic 수행
    # -----------------------------------------------------------------------
    lambda_cfg = config.get("lambda", {}) or {}
    deploy_lambda_arn = args.deploy_lambda_arn or lambda_cfg.get("deploy_endpoint_arn", "")
    if not deploy_lambda_arn:
        print("오류: endpoint 배포 Lambda ARN 이 필요합니다.")
        print("  infra/deploy_stack.py 를 다시 실행해 config.yaml의 lambda.deploy_endpoint_arn 을 채우세요.")
        sys.exit(1)

    deploy_step = LambdaStep(
        name="DeployEndpoint",
        lambda_func=Lambda(
            function_arn=deploy_lambda_arn,
            session=sagemaker_session,
        ),
        inputs={
            "endpoint_name": p_endpoint_name,
            "instance_type": p_endpoint_instance_type,
            "model_data": training_step.properties.ModelArtifacts.S3ModelArtifacts,
            "image_uri": inference_image_uri,
            "role_arn": role_arn,
            "region": region,
        },
        depends_on=[training_step],
    )

    # -----------------------------------------------------------------------
    # 파이프라인 조립
    # -----------------------------------------------------------------------
    pipeline_name = f"groot-sm-finetuning{suffix}"
    pipeline = Pipeline(
        name=pipeline_name,
        parameters=[
            p_embodiment_tag,
            p_dataset_s3_uri,
            p_instance_type,
            p_max_steps,
            p_global_batch_size,
            p_num_gpus,
            p_endpoint_name,
            p_endpoint_instance_type,
        ],
        steps=[training_step, register_step, deploy_step],
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
  # SO-101 leisaac-pick-orange 파이프라인 실행 (S3 채널):
  python pipeline/run_pipeline.py \\
      --dataset-s3-uri s3://my-bucket/datasets/leisaac-pick-orange

  # HF 직접 다운로드 + N1.7:
  python pipeline/run_pipeline.py \\
      --hf-dataset-id LightwheelAI/leisaac-pick-orange \\
      --hf-token ssm:/groot/hf-token \\
      --groot-version n1.7

  # 파이프라인 정의만 업서트:
  python pipeline/run_pipeline.py --upsert-only
        """,
    )

    # 필수 인수
    parser.add_argument("--embodiment-tag", default="NEW_EMBODIMENT",
                        help="로봇 embodiment 식별자 (기본값: NEW_EMBODIMENT)")
    parser.add_argument("--dataset-s3-uri", default="",
                        help="데이터셋 S3 URI (s3://bucket/prefix)")

    # 선택 인수 (config.yaml 기본값 사용)
    parser.add_argument("--bucket", default=aws_cfg.get("bucket_name", ""),
                        help="S3 버킷 이름")
    parser.add_argument("--region", default=aws_cfg.get("region", "us-east-1"),
                        help="AWS 리전")
    parser.add_argument("--role-arn", default=aws_cfg.get("role_arn", ""),
                        help="SageMaker 실행 역할 ARN")
    parser.add_argument("--training-image-uri", default=config.get("ecr", {}).get("training_uri", ""),
                        help="학습 컨테이너 ECR URI")
    parser.add_argument("--inference-image-uri", default=config.get("ecr", {}).get("inference_uri", ""),
                        help="추론 컨테이너 ECR URI (미지정 시 학습 URI 사용)")
    parser.add_argument("--instance-type", default=train_cfg.get("instance_type", "ml.g5.2xlarge"),
                        help="학습 인스턴스 타입 (기본 ml.g5.2xlarge)")
    parser.add_argument("--max-steps", type=int, default=int(train_cfg.get("max_steps", 6000)),
                        help="최대 학습 스텝")
    parser.add_argument("--global-batch-size", type=int, default=int(train_cfg.get("global_batch_size", 32)),
                        help="글로벌 배치 크기")
    parser.add_argument("--num-gpus", type=int, default=int(train_cfg.get("num_gpus", 1)),
                        help="GPU 수 (기본 1)")
    parser.add_argument("--hf-dataset-id", default="",
                        help="HF 데이터셋 ID (지정 시 컨테이너에서 직접 다운로드, --dataset-s3-uri 대신 사용)")
    parser.add_argument("--hf-token", default="",
                        help="HF 토큰 또는 'ssm:/groot/hf-token'")
    parser.add_argument("--groot-version", choices=["n1.6", "n1.7"], default=None,
                        help="ECR 이미지 태그 (:n1.6 / :n1.7)")
    parser.add_argument("--use-spot", dest="use_spot", action="store_true", default=None,
                        help="Spot Instance 사용 (기본값: config.yaml의 training.use_spot)")
    parser.add_argument("--no-spot", dest="use_spot", action="store_false",
                        help="Spot Instance 비활성화")
    parser.add_argument("--upsert-only", action="store_true",
                        help="파이프라인 정의만 업서트하고 실행하지 않음")
    parser.add_argument("--start-only", action="store_true",
                        help="파이프라인 업서트 없이 기존 파이프라인만 실행")
    parser.add_argument("--endpoint-name",
                        default=config.get("inference", {}).get("endpoint_name", ""),
                        help="배포할 endpoint 이름 (기본: config.yaml의 inference.endpoint_name)")
    parser.add_argument("--endpoint-instance-type",
                        default=config.get("inference", {}).get("instance_type", "ml.g5.2xlarge"),
                        help="endpoint 인스턴스 타입 (기본: config.yaml의 inference.instance_type)")
    parser.add_argument("--deploy-lambda-arn",
                        default=config.get("lambda", {}).get("deploy_endpoint_arn", ""),
                        help="endpoint 배포 LambdaStep 함수 ARN (기본: config.yaml의 lambda.deploy_endpoint_arn)")

    args = parser.parse_args()

    if not args.dataset_s3_uri and not args.hf_dataset_id and not args.upsert_only:
        print("오류: --dataset-s3-uri 또는 --hf-dataset-id 중 하나가 필요합니다.")
        sys.exit(1)

    print("파이프라인 빌드 중...")
    pipeline = build_pipeline(config, args)

    if not args.start_only:
        print("파이프라인 업서트 중 (정의 생성/업데이트)...")
        pipeline.upsert(role_arn=args.role_arn or config.get("aws", {}).get("role_arn", ""))
        print(f"파이프라인 업서트 완료: {pipeline.name}")

    if not args.upsert_only:
        print("파이프라인 실행 중...")
        # ParameterString/Integer 의 default 가 박혀있어도, --start-only 로 재실행할 때
        # CLI 인자가 그대로 동작하도록 모두 명시 전달.
        start_params = {
            "EmbodimentTag": args.embodiment_tag,
            "DatasetS3Uri": args.dataset_s3_uri,
            "MaxSteps": args.max_steps,
            "GlobalBatchSize": args.global_batch_size,
            "NumGpus": args.num_gpus,
        }
        if args.instance_type:
            start_params["InstanceType"] = args.instance_type
        if args.endpoint_name:
            start_params["EndpointName"] = args.endpoint_name
        if args.endpoint_instance_type:
            start_params["EndpointInstanceType"] = args.endpoint_instance_type

        execution = pipeline.start(parameters=start_params)
        infer_cfg = config.get("inference", {}) or {}
        endpoint_name = args.endpoint_name or infer_cfg.get("endpoint_name", "")
        print(f"\n파이프라인 실행 시작!")
        print(f"  실행 ARN: {execution.arn}")
        print(f"\n진행 상황 확인:")
        print(f"  AWS 콘솔 → SageMaker → Pipelines → {pipeline.name}")
        print(f"\n파이프라인 완료 후 (~15-20분):")
        print(f"  · endpoint 가 자동 배포됩니다 (LambdaStep). InService 까지 추가 5-10분 소요.")
        print(f"  · 상태 확인: aws sagemaker describe-endpoint --endpoint-name {endpoint_name}")
        print(f"  · 추론 호출: python scripts/invoke_endpoint.py --image-path ./sample/test.png ...")


if __name__ == "__main__":
    main()
