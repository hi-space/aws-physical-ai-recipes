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

  // workshop-studio 프로필: Workshop Studio 계정은 processing-job 허용 타입이 ml.g5.2xlarge
  // 하나뿐이라(ml.m5.2xlarge 기본 한도 0) TransformDataset 스텝을 그 타입으로 돌린다.
  if (out.DeploymentProfile === 'workshop-studio') {
    config.transform ??= {};
    config.transform.instance_type = 'ml.g5.2xlarge';
  }

  return config;
}
