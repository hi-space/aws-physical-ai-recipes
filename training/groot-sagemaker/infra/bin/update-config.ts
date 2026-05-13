#!/usr/bin/env node
/**
 * cdk deploy 후 CloudFormation outputs을 읽어 ../config.yaml을 갱신합니다.
 *
 * 사용법:
 *   npx ts-node bin/update-config.ts                 # alias 없는 기본 스택
 *   npx ts-node bin/update-config.ts --alias alice
 *   npx ts-node bin/update-config.ts --stack-name GrootSMTrainingJob-alice
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
  stackName?: string;
  alias?: string;
  region?: string;
  configPath?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--stack-name') args.stackName = next();
    else if (a === '--alias') args.alias = next();
    else if (a === '--region') args.region = next();
    else if (a === '--config-path') args.configPath = next();
    else if (a === '-h' || a === '--help') {
      console.log(
        'Usage: ts-node bin/update-config.ts [--stack-name N] [--alias A] [--region R] [--config-path P]',
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const region = args.region ?? process.env.AWS_REGION ?? process.env.CDK_DEFAULT_REGION ?? 'us-east-1';
  const alias = args.alias ?? '';
  const suffix = alias ? `-${alias}` : '';
  const stackName =
    args.stackName ?? (alias ? `GrootSMTrainingJob-${alias}` : 'GrootSMTrainingJob');

  const configPath =
    args.configPath ?? path.resolve(__dirname, '..', '..', 'config.yaml');

  if (!fs.existsSync(configPath)) {
    throw new Error(`config.yaml not found: ${configPath}`);
  }

  const cfn = new CloudFormationClient({ region });
  let stack: Stack | undefined;
  try {
    const resp = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
    stack = resp.Stacks?.[0];
  } catch (err: any) {
    throw new Error(`스택 '${stackName}' 조회 실패: ${err.message ?? err}`);
  }
  if (!stack) {
    throw new Error(`스택 '${stackName}' 을(를) 찾을 수 없습니다.`);
  }

  const outputs = outputsToMap(stack.Outputs);
  const accountId = stack.StackId?.split(':')[4] ?? '';

  const config = yaml.load(fs.readFileSync(configPath, 'utf-8')) as Record<string, any>;
  config.aws ??= {};
  config.aws.account_id = accountId;
  config.aws.alias = alias;
  config.aws.bucket_name = outputs.BucketName ?? config.aws.bucket_name ?? '';
  config.aws.role_arn = outputs.SageMakerRoleArn ?? config.aws.role_arn ?? '';
  config.aws.region = region;

  config.ecr ??= {};
  config.ecr.training_uri = outputs.TrainingRepositoryUri
    ? `${outputs.TrainingRepositoryUri}:latest`
    : config.ecr.training_uri ?? '';
  config.ecr.inference_uri = outputs.InferenceRepositoryUri
    ? `${outputs.InferenceRepositoryUri}:latest`
    : config.ecr.inference_uri ?? '';

  config.codebuild ??= {};
  config.codebuild.training_project =
    outputs.TrainingBuildProjectName ?? `groot-n16-training-build${suffix}`;
  config.codebuild.inference_project =
    outputs.InferenceBuildProjectName ?? `groot-n16-inference-build${suffix}`;

  config.inference ??= {};
  config.inference.endpoint_name = `groot-n16-endpoint${suffix}`;
  config.inference.model_package_group = `groot-n16-models${suffix}`;

  config.mlflow ??= {};
  config.mlflow.tracking_server_arn =
    outputs.MlflowTrackingServerArn ?? config.mlflow.tracking_server_arn ?? '';
  config.mlflow.tracking_server_name =
    outputs.MlflowTrackingServerName ?? `groot-mlflow${suffix}`;
  config.mlflow.experiment_name ??= 'groot-n16-finetune';

  config.lambda ??= {};
  config.lambda.deploy_endpoint_arn =
    outputs.DeployEndpointLambdaArn ?? config.lambda.deploy_endpoint_arn ?? '';
  config.lambda.deploy_endpoint_name =
    outputs.DeployEndpointLambdaName ?? `groot-deploy-endpoint${suffix}`;

  fs.writeFileSync(configPath, yaml.dump(config, { lineWidth: -1 }));

  console.log(`config.yaml 업데이트 완료: ${configPath}`);
  console.log('--------------------------------------------------');
  console.log(`  계정 ID         : ${accountId}`);
  console.log(`  리전             : ${region}`);
  console.log(`  S3 버킷          : ${outputs.BucketName}`);
  console.log(`  SageMaker 역할   : ${outputs.SageMakerRoleArn}`);
  console.log(`  Notebook 역할    : ${outputs.NotebookRoleArn}`);
  console.log(`  학습 ECR URI     : ${outputs.TrainingRepositoryUri}`);
  console.log(`  추론 ECR URI     : ${outputs.InferenceRepositoryUri}`);
  console.log(`  Studio 도메인 ID : ${outputs.StudioDomainId}`);
  console.log(`  Studio 사용자    : ${outputs.StudioUserProfileName}`);
  console.log(`  MLflow 서버 ARN  : ${outputs.MlflowTrackingServerArn}`);
  console.log(`  Deploy Lambda    : ${outputs.DeployEndpointLambdaArn}`);
}

main().catch((err) => {
  console.error('오류:', err.message ?? err);
  process.exit(1);
});
