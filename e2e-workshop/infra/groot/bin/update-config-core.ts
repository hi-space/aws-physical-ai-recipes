/**
 * CloudFormation outputs → config.yaml 객체 반영 (순수 함수, AWS 호출 없음).
 * bin/update-config.ts가 사용하며, 단독 테스트가 가능하다.
 */
export function applyOutputsToConfig(
  config: Record<string, any>,
  out: Record<string, string>,
  accountId: string,
  region: string,
): Record<string, any> {
  config.aws ??= {};
  config.aws.account_id = accountId;
  // alias는 파이프라인/모델 그룹 이름 접미사로 쓰인다. 1인 1계정 전제로 계정 ID를 쓴다.
  config.aws.alias = out.UserId ?? accountId;
  config.aws.bucket_name = out.BucketName ?? config.aws.bucket_name ?? '';
  config.aws.role_arn = out.SageMakerRoleArn ?? config.aws.role_arn ?? '';
  config.aws.region = region;

  config.ecr ??= {};
  config.ecr.training_uri = out.TrainingRepositoryUri
    ? `${out.TrainingRepositoryUri}:latest`
    : config.ecr.training_uri ?? '';

  config.codebuild ??= {};
  config.codebuild.training_project = out.SmTrainingBuildProjectName ?? 'groot-sm-training-build';

  config.mlflow ??= {};
  config.mlflow.tracking_server_arn =
    out.MlflowTrackingServerArn ?? config.mlflow.tracking_server_arn ?? '';
  config.mlflow.tracking_server_name =
    out.MlflowTrackingServerName ?? `groot-mlflow-${accountId}`;
  config.mlflow.experiment_name ??= 'groot-sm-finetune';

  // workshop-studio 프로필 — 인스턴스 타입 override 없음. Workshop Studio 이벤트 계정 SageMaker
  // 쿼터를 CreateJob 으로 직접 확인한 결과(2026-09, us-west-2):
  //   - processing: ml.m5.2xlarge 허용 → TransformDataset 기본값(ml.m5.2xlarge, CPU) 그대로.
  //   - processing: GPU 는 g5/g6/g4dn 전부 0 (Service Quotas 콘솔이 2 로 보여도 SageMaker 는 거부)
  //     → SmokeEval 은 Processing 이 아니라 Training Job 으로 돈다 (pipeline/build_pipeline.py).
  //   - training : g5/g6/g6e 각 1 → 학습 ml.g5.12xlarge, SmokeEval ml.g5.2xlarge 기본값 그대로.
  //   WS 계정 쿼터는 저자가 올릴 수 없으므로 파이프라인이 열려 있는 축(training)만 쓰도록 설계했다.

  return config;
}
