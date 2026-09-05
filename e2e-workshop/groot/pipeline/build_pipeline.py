"""GR00T 파인튜닝 SageMaker Pipeline 조립 (Transform → Train → SmokeEval → Gate → Register)."""
from pathlib import Path

from sagemaker.estimator import Estimator
from sagemaker.inputs import TrainingInput
from sagemaker.model import Model
from sagemaker.processing import FrameworkProcessor, ProcessingOutput
from sagemaker.pytorch.estimator import PyTorch
from sagemaker.sklearn.estimator import SKLearn
from sagemaker.workflow.condition_step import ConditionStep
from sagemaker.workflow.conditions import ConditionEquals
from sagemaker.workflow.execution_variables import ExecutionVariables
from sagemaker.workflow.fail_step import FailStep
from sagemaker.workflow.functions import Join, JsonGet
from sagemaker.workflow.model_step import ModelStep
from sagemaker.workflow.parameters import ParameterInteger, ParameterString
from sagemaker.workflow.pipeline import Pipeline
from sagemaker.workflow.retry import (
    SageMakerJobExceptionTypeEnum,
    SageMakerJobStepRetryPolicy,
)
from sagemaker.workflow.steps import CacheConfig, ProcessingStep, TrainingStep


def _is_gpu_instance(instance_type: str) -> bool:
    """ml.g*/ml.p* 계열이면 True (예: ml.g5.2xlarge)."""
    parts = str(instance_type).split(".")
    return len(parts) >= 2 and parts[1].startswith(("g", "p"))


def _transform_processor(*, instance_type, role, session):
    """TransformDataset 용 FrameworkProcessor.

    - CPU 타입(personal 기본 ml.m5.2xlarge): SageMaker SKLearn 이미지 (작고 빠름).
    - GPU 타입(workshop-studio: ml.g5.2xlarge — ml.m5 processing 한도 0): SKLearn 이미지는
      CPU 전용이라 SDK가 'Unsupported processor: gpu'로 거부하므로 PyTorch 이미지(cpu+gpu)를 쓴다.
      transform_dataset.py 는 GPU를 쓰지 않으며 requirements.txt 자동 설치는 두 경로 모두 동일.
    """
    common = dict(role=role, instance_type=instance_type, instance_count=1,
                  volume_size_in_gb=100, sagemaker_session=session)
    if _is_gpu_instance(instance_type):
        return FrameworkProcessor(estimator_cls=PyTorch, framework_version="2.5.1",
                                  py_version="py311", **common)
    return FrameworkProcessor(estimator_cls=SKLearn, framework_version="1.2-1", **common)


def build_pipeline(*, session, role, training_image_uri, bucket, source_root,
                   model_prefix="models/groot-sm",
                   model_package_group="groot-sm-models",
                   hf_dataset_id="LightwheelAI/leisaac-pick-orange",
                   transform_instance_type="ml.m5.2xlarge",
                   train_instance_type="ml.g5.12xlarge",
                   eval_instance_type="ml.g5.2xlarge",
                   max_steps=100, global_batch_size=32, save_steps=50,
                   num_gpus=0, embodiment_tag="NEW_EMBODIMENT", alias="", env=None):
    root = Path(source_root)
    model_prefix = (model_prefix or "models/groot-sm").strip("/")
    exec_id = ExecutionVariables.PIPELINE_EXECUTION_ID

    p_embodiment = ParameterString(name="EmbodimentTag", default_value=embodiment_tag)
    p_hf_dataset = ParameterString(name="HfDatasetId", default_value=hf_dataset_id)
    p_train_inst = ParameterString(name="InstanceType", default_value=train_instance_type)
    # 평가 인스턴스도 런타임 파라미터: 계정/리전의 GPU training 쿼터·용량에 따라
    # re-upsert 없이 다른 단일 GPU 타입으로 바꿔 실행할 수 있어야 한다.
    p_eval_inst = ParameterString(name="EvalInstanceType", default_value=eval_instance_type)
    p_max_steps = ParameterInteger(name="MaxSteps", default_value=int(max_steps))
    p_global_batch = ParameterInteger(name="GlobalBatchSize", default_value=int(global_batch_size))
    p_num_gpus = ParameterInteger(name="NumGpus", default_value=int(num_gpus))
    # 체크포인트 저장 간격도 런타임 파라미터. 3B 모델 체크포인트 한 번에 학습이 2~3분 멈추고
    # (/opt/ml/checkpoints → S3 동기화 포함) 저장마다 수십 GB 가 S3 에 쌓이므로, 100 스텝 Quick
    # validation 은 기본 50 이 맞지만 6000 스텝 본격 학습은 500~1000 으로 올려 실행해야 한다.
    p_save_steps = ParameterInteger(name="SaveSteps", default_value=int(save_steps))

    # 1) TransformDataset — FrameworkProcessor(SKLearn|PyTorch) + source_dir(requirements.txt 자동설치)
    transform_processor = _transform_processor(
        instance_type=transform_instance_type, role=role, session=session)
    transform_out = Join(on="/", values=[f"s3://{bucket}/processed", exec_id])
    transform_args = transform_processor.run(
        code="transform_dataset.py",
        source_dir=str(root / "training" / "data"),
        arguments=["--hf-dataset-id", p_hf_dataset,
                   "--output-dir", "/opt/ml/processing/output",
                   "--region", session.boto_region_name],
        outputs=[ProcessingOutput(output_name="dataset",
                                  source="/opt/ml/processing/output",
                                  destination=transform_out)])
    transform_step = ProcessingStep(name="TransformDataset", step_args=transform_args,
                                    cache_config=CacheConfig(enable_caching=True, expire_after="30d"))
    dataset_uri = transform_step.properties.ProcessingOutputConfig.Outputs["dataset"].S3Output.S3Uri

    # 2) GR00TFinetune — 기존 train.py, dataset 채널 = transform 출력
    checkpoint_s3 = Join(on="/", values=[f"s3://{bucket}/checkpoints", exec_id])
    export_s3_uri = Join(on="/", values=[f"s3://{bucket}/{model_prefix}", exec_id])
    estimator = Estimator(
        image_uri=training_image_uri, role=role, entry_point="train.py",
        source_dir=str(root / "training" / "container"),
        instance_type=p_train_inst, instance_count=1,
        output_path=f"s3://{bucket}/output", checkpoint_s3_uri=checkpoint_s3,
        metric_definitions=[{"Name": "train:loss", "Regex": r"'loss':\s*([0-9.eE+-]+)"},
                            {"Name": "eval:loss", "Regex": r"'eval_loss':\s*([0-9.eE+-]+)"}],
        hyperparameters={"embodiment_tag": p_embodiment, "max_steps": p_max_steps,
                         "global_batch_size": p_global_batch, "save_steps": p_save_steps,
                         "num_gpus": p_num_gpus, "export_s3_uri": export_s3_uri},
        sagemaker_session=session, environment=env or {})
    train_args = estimator.fit(inputs={"dataset": TrainingInput(s3_data=dataset_uri)})
    training_step = TrainingStep(
        name="GR00TFinetune", step_args=train_args,
        depends_on=["TransformDataset"],
        # 기본값은 재시도 없음이라, 같은 타입의 이전 Job이 아직 정리 중일 때
        # (쿼터 잔여 0 → ResourceLimitExceeded)나 GPU 용량 오류(CapacityError)로
        # 스텝이 즉시 실패한다. 둘 다 시간이 해결하는 오류이므로 백오프 재시도한다.
        retry_policies=[
            SageMakerJobStepRetryPolicy(
                exception_types=[
                    SageMakerJobExceptionTypeEnum.RESOURCE_LIMIT,
                    SageMakerJobExceptionTypeEnum.CAPACITY_ERROR,
                ],
                interval_seconds=180,
                backoff_rate=2.0,
                max_attempts=5,
            ),
        ])

    # 3) SmokeEval — training 이미지로 도는 **Training Job** (model.tar.gz 를 "model" 채널로 입력).
    # Processing Job 이 아닌 이유: Workshop Studio 이벤트 계정은 GPU "processing job usage"
    # 쿼터가 전 타입 0 이다 (g5/g6/g4dn 실측 — Service Quotas 콘솔이 2 로 보여도 SageMaker 는
    # 0 으로 거부). 반면 "training job usage" 는 g5/g6/g6e 각 1 이 열려 있다. 학습 이미지에
    # sagemaker-training 툴킷이 있어 entry_point 방식이 그대로 동작한다.
    # 결과 evaluation.json 은 training job 의 output.tar.gz 로 묶이면 게이트가 읽을 수 없으므로,
    # 스크립트가 report_s3_uri 로 직접 업로드하고 SmokeGate 는 JsonGet(s3_uri) 로 읽는다.
    smoke_report_uri = Join(on="/", values=[f"s3://{bucket}/smoke-eval", exec_id, "evaluation.json"])
    eval_estimator = Estimator(
        image_uri=training_image_uri, role=role, entry_point="smoke_eval.py",
        source_dir=str(root / "pipeline"),
        instance_type=p_eval_inst, instance_count=1, volume_size=100, max_run=3600,
        output_path=f"s3://{bucket}/smoke-eval",
        hyperparameters={"report_s3_uri": smoke_report_uri},
        sagemaker_session=session)
    eval_args = eval_estimator.fit(inputs={"model": TrainingInput(
        s3_data=training_step.properties.ModelArtifacts.S3ModelArtifacts)})
    eval_step = TrainingStep(name="SmokeEval", step_args=eval_args,
                             # GR00TFinetune 과 같은 이유의 백오프 재시도 (training 쿼터/용량)
                             retry_policies=[
                                 SageMakerJobStepRetryPolicy(
                                     exception_types=[
                                         SageMakerJobExceptionTypeEnum.RESOURCE_LIMIT,
                                         SageMakerJobExceptionTypeEnum.CAPACITY_ERROR,
                                     ],
                                     interval_seconds=180,
                                     backoff_rate=2.0,
                                     max_attempts=5,
                                 ),
                             ])

    # 4) RegisterModel (pass) / FailStep (fail)
    # training_image_uri를 그대로 inference image_uri로 쓰는 것은 Model Registry 거버넌스
    # (버전·승인상태 추적)용일 뿐이다 — 스펙상 엔드포인트 배포는 하지 않으므로, 등록된 모델
    # 패키지가 이 이미지로 그대로 배포 가능하다는 뜻은 아니다(추론 전용 이미지 아님).
    model = Model(image_uri=training_image_uri,
                  model_data=training_step.properties.ModelArtifacts.S3ModelArtifacts,
                  sagemaker_session=session, role=role)
    register_step = ModelStep(name="RegisterModel", step_args=model.register(
        content_types=["application/x-npy"], response_types=["application/json"],
        inference_instances=["ml.g6.4xlarge"], transform_instances=["ml.g6.4xlarge"],
        model_package_group_name=model_package_group, approval_status="Approved"))
    fail_step = FailStep(name="SmokeFailed",
                         error_message="Smoke eval failed — model not registered")
    # JsonGet(s3_uri) 는 스텝 속성 참조가 아니라서 의존성이 자동 생성되지 않는다 → depends_on 명시.
    gate = ConditionStep(
        name="SmokeGate",
        conditions=[ConditionEquals(
            left=JsonGet(s3_uri=smoke_report_uri, json_path="smoke.passed"), right=1)],
        if_steps=[register_step], else_steps=[fail_step],
        depends_on=[eval_step])

    return Pipeline(
        name=f"groot-sm-finetuning{('-' + alias) if alias else ''}",
        parameters=[p_embodiment, p_hf_dataset, p_train_inst, p_eval_inst,
                    p_max_steps, p_global_batch, p_num_gpus, p_save_steps],
        steps=[transform_step, training_step, eval_step, gate],
        sagemaker_session=session)
