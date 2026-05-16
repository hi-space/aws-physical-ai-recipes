#!/usr/bin/env node
/**
 * cdk deploy 후 CloudFormation outputs을 읽어 config.yaml을 갱신합니다.
 *
 * 사용법:
 *   npx ts-node bin/update-config.ts --user-id alice
 *   npx ts-node bin/update-config.ts --user-id alice --config-path /path/to/config.yaml
 *
 * 두 스택(GrootFinetuneShared + GrootFinetuneSagemaker[-userId])의 outputs를 합쳐서
 * config.yaml을 갱신합니다.
 */
import {
  CloudFormationClient,
  DescribeStacksCommand,
  Output,
  Stack,
} from '@aws-sdk/client-cloudformation';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

interface Args {
  userId?: string;
  region?: string;
  configPath?: string;
  sharedStackName?: string;
  userStackName?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--user-id') args.userId = next();
    else if (a === '--region') args.region = next();
    else if (a === '--config-path') args.configPath = next();
    else if (a === '--shared-stack-name') args.sharedStackName = next();
    else if (a === '--user-stack-name') args.userStackName = next();
    else if (a === '-h' || a === '--help') {
      console.log(
        'Usage: ts-node bin/update-config.ts --user-id <id> [--region R] [--config-path P]',
      );
      process.exit(0);
    }
  }
  return args;
}

function outputsToMap(outputs: Output[] | undefined): Record<string, string> {
  const m: Record<string, string> = {};
  for (const o of outputs ?? []) {
    if (o.OutputKey && o.OutputValue !== undefined) {
      m[o.OutputKey] = o.OutputValue;
    }
  }
  return m;
}

async function describeStack(cfn: CloudFormationClient, name: string): Promise<Stack | undefined> {
  try {
    const resp = await cfn.send(new DescribeStacksCommand({ StackName: name }));
    return resp.Stacks?.[0];
  } catch (err: any) {
    throw new Error(`스택 '${name}' 조회 실패: ${err.message ?? err}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const region = args.region ?? process.env.AWS_REGION ?? process.env.CDK_DEFAULT_REGION ?? 'us-east-1';
  const userId = args.userId ?? '';
  const suffix = userId ? `-${userId}` : '';

  const sharedStackName = args.sharedStackName ?? 'GrootFinetuneShared';
  const userStackName = args.userStackName ?? `GrootFinetuneSagemaker${suffix}`;

  // 기본 config.yaml 위치: 옛 groot-sagemaker/config.yaml 그대로(스크립트들이 거기서 읽음).
  const configPath =
    args.configPath ??
    path.resolve(__dirname, '..', '..', '..', 'training', 'groot-sagemaker', 'config.yaml');

  if (!fs.existsSync(configPath)) {
    throw new Error(`config.yaml not found: ${configPath}`);
  }

  const cfn = new CloudFormationClient({ region });
  const sharedStack = await describeStack(cfn, sharedStackName);
  if (!sharedStack) throw new Error(`스택 '${sharedStackName}' 을(를) 찾을 수 없습니다.`);
  const userStack = await describeStack(cfn, userStackName);
  if (!userStack) throw new Error(`스택 '${userStackName}' 을(를) 찾을 수 없습니다.`);

  const sharedOut = outputsToMap(sharedStack.Outputs);
  const userOut = outputsToMap(userStack.Outputs);
  const accountId = userStack.StackId?.split(':')[4] ?? '';

  const config = yaml.load(fs.readFileSync(configPath, 'utf-8')) as Record<string, any>;
  config.aws ??= {};
  config.aws.account_id = accountId;
  config.aws.alias = userId;
  config.aws.bucket_name = userOut.BucketName ?? config.aws.bucket_name ?? '';
  config.aws.role_arn = userOut.SageMakerRoleArn ?? config.aws.role_arn ?? '';
  config.aws.region = region;

  config.ecr ??= {};
  config.ecr.training_uri = userOut.TrainingRepositoryUri
    ? `${userOut.TrainingRepositoryUri}:latest`
    : config.ecr.training_uri ?? '';
  config.ecr.inference_uri = userOut.InferenceRepositoryUri
    ? `${userOut.InferenceRepositoryUri}:latest`
    : config.ecr.inference_uri ?? '';

  config.codebuild ??= {};
  config.codebuild.training_project = sharedOut.SmTrainingBuildProjectName ?? 'groot-sm-training-build';
  config.codebuild.inference_project = sharedOut.SmInferenceBuildProjectName ?? 'groot-sm-inference-build';

  config.inference ??= {};
  config.inference.endpoint_name = `groot-sm-endpoint${suffix}`;
  config.inference.model_package_group = `groot-sm-models${suffix}`;

  config.mlflow ??= {};
  config.mlflow.tracking_server_arn =
    userOut.MlflowTrackingServerArn ?? config.mlflow.tracking_server_arn ?? '';
  config.mlflow.tracking_server_name =
    userOut.MlflowTrackingServerName ?? `groot-mlflow${suffix}`;
  config.mlflow.experiment_name ??= 'groot-sm-finetune';

  config.lambda ??= {};
  config.lambda.deploy_endpoint_arn =
    userOut.DeployEndpointLambdaArn ?? config.lambda.deploy_endpoint_arn ?? '';
  config.lambda.deploy_endpoint_name =
    userOut.DeployEndpointLambdaName ?? `groot-deploy-endpoint${suffix}`;

  fs.writeFileSync(configPath, yaml.dump(config, { lineWidth: -1 }));

  console.log(`config.yaml 업데이트 완료: ${configPath}`);
  console.log('--------------------------------------------------');
  console.log(`  계정 ID         : ${accountId}`);
  console.log(`  리전             : ${region}`);
  console.log(`  사용자 ID        : ${userId || '(none)'}`);
  console.log(`  S3 버킷          : ${userOut.BucketName}`);
  console.log(`  SageMaker 역할   : ${userOut.SageMakerRoleArn}`);
  console.log(`  Notebook 역할    : ${userOut.NotebookRoleArn}`);
  console.log(`  학습 ECR URI     : ${userOut.TrainingRepositoryUri}`);
  console.log(`  추론 ECR URI     : ${userOut.InferenceRepositoryUri}`);
  console.log(`  Studio 도메인 ID : ${sharedOut.StudioDomainId}`);
  console.log(`  Studio 사용자    : ${userOut.StudioUserProfileName}`);
  console.log(`  MLflow 서버 ARN  : ${userOut.MlflowTrackingServerArn}`);
  console.log(`  Deploy Lambda    : ${userOut.DeployEndpointLambdaArn}`);
}

main().catch((err) => {
  console.error('오류:', err.message ?? err);
  process.exit(1);
});
