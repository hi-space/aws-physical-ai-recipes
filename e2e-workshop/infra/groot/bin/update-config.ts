#!/usr/bin/env node
/**
 * cdk deploy 후 CloudFormation outputs을 읽어 config.yaml을 갱신합니다.
 *
 * 사용법:
 *   npx ts-node bin/update-config.ts
 *   npx ts-node bin/update-config.ts --region us-east-1 --config-path /path/to/config.yaml
 *
 * 통합 스택 GrootFinetune-<ACCOUNT_ID>의 outputs로 config.yaml을 갱신합니다.
 * (1인 1계정 전제 — 계정 ID는 배포된 GrootFinetune-* 스택에서 자동으로 찾습니다.)
 */
import {
  CloudFormationClient,
  DescribeStacksCommand,
  ListStacksCommand,
  Output,
  Stack,
} from '@aws-sdk/client-cloudformation';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

import { applyOutputsToConfig } from './update-config-core';

interface Args {
  region?: string;
  configPath?: string;
  stackName?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--region') args.region = next();
    else if (a === '--config-path') args.configPath = next();
    else if (a === '--stack-name') args.stackName = next();
    else if (a === '-h' || a === '--help') {
      console.log(
        'Usage: ts-node bin/update-config.ts [--region R] [--config-path P] [--stack-name S]',
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

/** --stack-name 생략 시, 배포된 GrootFinetune-* 스택을 자동 탐색한다. */
async function discoverStackName(cfn: CloudFormationClient): Promise<string> {
  const prefix = 'GrootFinetune-';
  const found: string[] = [];
  let token: string | undefined;
  do {
    const resp = await cfn.send(new ListStacksCommand({
      NextToken: token,
      StackStatusFilter: ['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE', 'IMPORT_COMPLETE'],
    }));
    for (const s of resp.StackSummaries ?? []) {
      if (s.StackName?.startsWith(prefix)) found.push(s.StackName);
    }
    token = resp.NextToken;
  } while (token);

  if (found.length === 0) {
    throw new Error(`배포된 ${prefix}* 스택이 없습니다. 먼저 cdk deploy 하거나 --stack-name 을 지정하세요.`);
  }
  if (found.length > 1) {
    throw new Error(`${prefix}* 스택이 여러 개입니다(${found.join(', ')}). --stack-name 으로 지정하세요.`);
  }
  return found[0];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const region = args.region ?? process.env.AWS_REGION ?? process.env.CDK_DEFAULT_REGION ?? 'us-east-1';

  const cfn = new CloudFormationClient({ region });
  const stackName = args.stackName ?? await discoverStackName(cfn);

  // config.yaml 위치: e2e-workshop/groot/config.yaml (모든 SM 스크립트가 여기서 읽음).
  const configPath =
    args.configPath ??
    path.resolve(__dirname, '..', '..', '..', 'groot', 'config.yaml');

  if (!fs.existsSync(configPath)) {
    throw new Error(`config.yaml not found: ${configPath}`);
  }

  const stack = await describeStack(cfn, stackName);
  if (!stack) throw new Error(`스택 '${stackName}' 을(를) 찾을 수 없습니다.`);

  const out = outputsToMap(stack.Outputs);
  const accountId = stack.StackId?.split(':')[4] ?? '';

  const config = yaml.load(fs.readFileSync(configPath, 'utf-8')) as Record<string, any>;
  applyOutputsToConfig(config, out, accountId, region);

  fs.writeFileSync(configPath, yaml.dump(config, { lineWidth: -1 }));

  console.log(`config.yaml 업데이트 완료: ${configPath}`);
  console.log('--------------------------------------------------');
  console.log(`  계정 ID         : ${accountId}`);
  console.log(`  리전             : ${region}`);
  console.log(`  스택             : ${stackName}`);
  console.log(`  S3 버킷          : ${out.BucketName}`);
  console.log(`  SageMaker 역할   : ${out.SageMakerRoleArn}`);
  console.log(`  Notebook 역할    : ${out.NotebookRoleArn}`);
  console.log(`  학습 ECR URI     : ${out.TrainingRepositoryUri}`);
  console.log(`  Studio 도메인 ID : ${out.StudioDomainId}`);
  console.log(`  Studio 사용자    : ${out.StudioUserProfileName}`);
  console.log(`  MLflow 서버 ARN  : ${out.MlflowTrackingServerArn}`);
  console.log(`  배포 프로필      : ${out.DeploymentProfile ?? 'personal'}`);
  console.log(`  Transform 타입   : ${config.transform?.instance_type}`);
}

main().catch((err) => {
  console.error('오류:', err.message ?? err);
  process.exit(1);
});
