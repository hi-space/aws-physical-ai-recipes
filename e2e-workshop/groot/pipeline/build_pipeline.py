"""GR00T 파인튜닝 SageMaker Pipeline 조립 (Transform → Train → SmokeEval → Gate → Register)."""
from pathlib import Path

from sagemaker.estimator import Estimator
from sagemaker.inputs import TrainingInput
from sagemaker.model import Model
from sagemaker.processing import FrameworkProcessor, ProcessingInput, ProcessingOutput, ScriptProcessor
from sagemaker.sklearn.estimator import SKLearn
from sagemaker.workflow.condition_step import ConditionStep
from sagemaker.workflow.conditions import ConditionEquals
from sagemaker.workflow.execution_variables import ExecutionVariables
from sagemaker.workflow.fail_step import FailStep
from sagemaker.workflow.functions import Join, JsonGet
from sagemaker.workflow.model_step import ModelStep
from sagemaker.workflow.parameters import ParameterInteger, ParameterString
from sagemaker.workflow.pipeline import Pipeline
from sagemaker.workflow.properties import PropertyFile
from sagemaker.workflow.steps import CacheConfig, ProcessingStep, TrainingStep


def build_pipeline(*, session, role, training_image_uri, bucket, source_root,
                   model_prefix="models/groot-sm",
                   model_package_group="groot-sm-models",
                   hf_dataset_id="LightwheelAI/leisaac-pick-orange",
                   transform_instance_type="ml.m5.2xlarge",
                   train_instance_type="ml.g6e.12xlarge",
                   eval_instance_type="ml.g6.xlarge",
                   max_steps=100, global_batch_size=32, save_steps=50,
                   num_gpus=0, embodiment_tag="NEW_EMBODIMENT", alias="", env=None):
    root = Path(source_root)
    model_prefix = (model_prefix or "models/groot-sm").strip("/")
    exec_id = ExecutionVariables.PIPELINE_EXECUTION_ID

    p_embodiment = ParameterString(name="EmbodimentTag", default_value=embodiment_tag)
    p_hf_dataset = ParameterString(name="HfDatasetId", default_value=hf_dataset_id)
    p_train_inst = ParameterString(name="InstanceType", default_value=train_instance_type)
    p_max_steps = ParameterInteger(name="MaxSteps", default_value=int(max_steps))
    p_global_batch = ParameterInteger(name="GlobalBatchSize", default_value=int(global_batch_size))
    p_num_gpus = ParameterInteger(name="NumGpus", default_value=int(num_gpus))

    # 1) TransformDataset — FrameworkProcessor(SKLearn) + source_dir(requirements.txt 자동설치)
    transform_processor = FrameworkProcessor(
        estimator_cls=SKLearn, framework_version="1.2-1", role=role,
        instance_type=transform_instance_type, instance_count=1,
        volume_size_in_gb=100, sagemaker_session=session)
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
                         "global_batch_size": p_global_batch, "save_steps": str(save_steps),
                         "num_gpus": p_num_gpus, "export_s3_uri": export_s3_uri},
        sagemaker_session=session, environment=env or {})
    train_args = estimator.fit(inputs={"dataset": TrainingInput(s3_data=dataset_uri)})
    training_step = TrainingStep(name="GR00TFinetune", step_args=train_args,
                                 depends_on=["TransformDataset"])

    # 3) SmokeEval — training 이미지(ScriptProcessor) + model.tar.gz 입력
    eval_processor = ScriptProcessor(
        image_uri=training_image_uri, command=["python3"], role=role,
        instance_type=eval_instance_type, instance_count=1,
        volume_size_in_gb=100, sagemaker_session=session)
    smoke_report = PropertyFile(name="SmokeEvalReport", output_name="evaluation",
                                path="evaluation.json")
    eval_args = eval_processor.run(
        code=str(root / "pipeline" / "smoke_eval.py"),
        inputs=[ProcessingInput(source=training_step.properties.ModelArtifacts.S3ModelArtifacts,
                                destination="/opt/ml/processing/input")],
        outputs=[ProcessingOutput(output_name="evaluation", source="/opt/ml/processing/output")])
    eval_step = ProcessingStep(name="SmokeEval", step_args=eval_args,
                               property_files=[smoke_report])

    # 4) RegisterModel (pass) / FailStep (fail)
    # training_image_uri를 그대로 inference image_uri로 쓰는 것은 Model Registry 거버넌스
    # (버전·승인상태 추적)용일 뿐이다 — 스펙상 엔드포인트 배포는 하지 않으므로, 등록된 모델
    # 패키지가 이 이미지로 그대로 배포 가능하다는 뜻은 아니다(추론 전용 이미지 아님).
    model = Model(image_uri=training_image_uri,
                  model_data=training_step.properties.ModelArtifacts.S3ModelArtifacts,
                  sagemaker_session=session, role=role)
    register_step = ModelStep(name="RegisterModel", step_args=model.register(
        content_types=["application/x-npy"], response_types=["application/json"],
        inference_instances=["ml.g6.xlarge"], transform_instances=["ml.g6.xlarge"],
        model_package_group_name=model_package_group, approval_status="Approved"))
    fail_step = FailStep(name="SmokeFailed",
                         error_message="Smoke eval failed — model not registered")
    gate = ConditionStep(
        name="SmokeGate",
        conditions=[ConditionEquals(
            left=JsonGet(step_name=eval_step.name, property_file=smoke_report,
                         json_path="smoke.passed"), right=1)],
        if_steps=[register_step], else_steps=[fail_step])

    return Pipeline(
        name=f"groot-sm-finetuning{('-' + alias) if alias else ''}",
        parameters=[p_embodiment, p_hf_dataset, p_train_inst, p_max_steps,
                    p_global_batch, p_num_gpus],
        steps=[transform_step, training_step, eval_step, gate],
        sagemaker_session=session)
