#!/usr/bin/env node
/**
 * GR00T SageMaker 파인튜닝 인프라 CDK 앱.
 *
 * 사용법:
 *   # 기본 (단일 사용자, alias 없음)
 *   npx cdk deploy -c bucketName=my-groot-artifacts
 *
 *   # 멀티 사용자 (alias로 리소스 이름 충돌 방지)
 *   npx cdk deploy -c bucketName=my-groot-artifacts-alice -c alias=alice
 *
 *   # VPC/Subnet 명시
 *   npx cdk deploy -c bucketName=... -c vpcId=vpc-xxx -c subnetIds=subnet-a,subnet-b
 *
 * VPC/Subnet 결정 우선순위:
 *   1) -c vpcId + -c subnetIds 명시값
 *   2) alias 지정 시 IsaacLab-{Latest,Stable}-${alias} 부모 스택의 PrivateSubnetId
 *   3) 계정 default VPC + 모든 subnet (synth-time lookup)
 */
import * as cdk from 'aws-cdk-lib';
import { GrootSmStack } from '../lib/groot-sm-stack';

const app = new cdk.App();

const bucketName = app.node.tryGetContext('bucketName');
if (!bucketName) {
  throw new Error(
    'Required: -c bucketName=<unique-bucket>\n\n' +
      'Example:\n' +
      '  npx cdk deploy -c bucketName=my-groot-artifacts-20240101\n' +
      '  npx cdk deploy -c bucketName=my-groot-artifacts-alice -c alias=alice',
  );
}

const alias: string = app.node.tryGetContext('alias') ?? '';
const region: string =
  app.node.tryGetContext('region') ?? process.env.CDK_DEFAULT_REGION ?? 'us-east-1';
const account: string | undefined =
  app.node.tryGetContext('account') ?? process.env.CDK_DEFAULT_ACCOUNT;

const vpcIdCtx: string | undefined = app.node.tryGetContext('vpcId');
const subnetIdsCtx: string | undefined = app.node.tryGetContext('subnetIds');
const availabilityZoneCtx: string | undefined =
  app.node.tryGetContext('availabilityZone');
const repositoryUrl: string = app.node.tryGetContext('repositoryUrl') ?? '';
const mlflowSize: string = app.node.tryGetContext('mlflowSize') ?? 'Small';
const roleName: string = app.node.tryGetContext('roleName') ?? 'GR00TSageMakerRole';
const codeBuildRoleName: string =
  app.node.tryGetContext('codeBuildRoleName') ?? 'GR00TCodeBuildRole';
const notebookRoleName: string =
  app.node.tryGetContext('notebookRoleName') ?? 'GR00TNotebookRole';

const stackName = alias ? `GrootSMTrainingJob-${alias}` : 'GrootSMTrainingJob';

const subnetIds = subnetIdsCtx
  ? subnetIdsCtx
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  : undefined;

if ((vpcIdCtx && !subnetIds) || (!vpcIdCtx && subnetIds)) {
  throw new Error(
    '-c vpcId 와 -c subnetIds 는 함께 지정해야 합니다 (둘 다 비우면 자동 탐지).',
  );
}

new GrootSmStack(app, stackName, {
  stackName,
  env: { account, region },
  alias,
  bucketName,
  repositoryUrl,
  mlflowSize,
  roleName,
  codeBuildRoleName,
  notebookRoleName,
  vpcId: vpcIdCtx,
  subnetIds,
  availabilityZone: availabilityZoneCtx,
  tags: {
    Project: 'GR00T-N1.6',
    ...(alias ? { Alias: alias } : {}),
  },
});
