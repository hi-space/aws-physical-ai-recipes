#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { GrootFinetuneSharedStack } from '../lib/groot-finetune-shared-stack';
import { GrootBatchTrainStack } from '../lib/groot-batch-train-stack';
import { GrootSagemakerStack } from '../lib/groot-sagemaker-stack';
import { resolveParentStack, saveToContext } from './resolve-parent-stack';

function parseList(value: unknown): string[] | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}

async function main() {
  const app = new cdk.App();

  const region = app.node.tryGetContext('region') ?? process.env.CDK_DEFAULT_REGION ?? 'us-east-1';
  const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region };

  const userId = app.node.tryGetContext('userId') as string | undefined;
  const userSuffix = userId ? `-${userId}` : '';

  const useStableGroot = (app.node.tryGetContext('useStableGroot') ?? 'true') === 'true';
  const grootVersion = app.node.tryGetContext('grootVersion') ?? 'n1.6';
  const repositoryUrl = app.node.tryGetContext('repositoryUrl') ?? '';

  // ---- [1] Shared (admin once) ----
  // 단일 통합 shared. Studio Domain VPC 우선순위:
  //   1. -c sharedVpcId/sharedSubnetIds 명시값
  //   2. cdk.context.json에 캐시된 per-user VPC (이전 배포 값 재사용)
  //   3. default VPC 자동 탐지 (resolveVpcAndSubnets)
  const cachedSubnet = app.node.tryGetContext('privateSubnetId') as string | undefined;
  const sharedVpcId = (app.node.tryGetContext('sharedVpcId') as string | undefined)
    ?? (app.node.tryGetContext('vpcId') as string | undefined);
  const sharedSubnetIds = parseList(app.node.tryGetContext('sharedSubnetIds'))
    ?? (cachedSubnet ? [cachedSubnet] : undefined);

  new GrootFinetuneSharedStack(app, 'GrootFinetuneShared', {
    stackName: 'GrootFinetuneShared',
    env,
    useStableGroot,
    grootVersion,
    repositoryUrl,
    vpcId: sharedVpcId,
    subnetIds: sharedSubnetIds,
  });

  // ---- [2] Per-user: parent IsaacLab 스택에서 VPC/EFS 자동 탐색 ----
  let vpcId = app.node.tryGetContext('vpcId') as string | undefined;
  let efsFileSystemId = app.node.tryGetContext('efsFileSystemId') as string | undefined;
  let efsSecurityGroupId = app.node.tryGetContext('efsSecurityGroupId') as string | undefined;
  let privateSubnetId = app.node.tryGetContext('privateSubnetId') as string | undefined;
  let availabilityZone = app.node.tryGetContext('availabilityZone') as string | undefined;

  const missingInfra = !vpcId || !efsFileSystemId || !efsSecurityGroupId || !privateSubnetId || !availabilityZone;
  if (missingInfra && userId) {
    console.error(`[GrootFinetune] Resolving parent IsaacLab stack for userId="${userId}" in ${region}...`);
    const params = await resolveParentStack(userId, region);
    saveToContext({ userId, ...params, region });
    ({ vpcId, efsFileSystemId, efsSecurityGroupId, privateSubnetId, availabilityZone } = params);
    console.error(`[GrootFinetune] Resolved: vpc=${vpcId}, efs=${efsFileSystemId}, az=${availabilityZone}`);
  }

  // ---- [3] Per-user Batch ----
  // userId가 있거나 명시 인프라가 모두 있을 때만 등록.
  if (!missingInfra || userId) {
    new GrootBatchTrainStack(app, 'GrootBatchTrain', {
      stackName: `GrootBatchTrain${userSuffix}`,
      env,
      vpcId: vpcId!,
      efsFileSystemId: efsFileSystemId!,
      efsSecurityGroupId: efsSecurityGroupId!,
      privateSubnetId: privateSubnetId!,
      availabilityZone: availabilityZone!,
      userId,
    });
  }

  // ---- [4] Per-user SageMaker ----
  // bucketName 기본값: groot-sm-artifacts-${userId}
  const bucketName = (app.node.tryGetContext('bucketName') as string | undefined)
    ?? (userId ? `groot-sm-artifacts-${userId}` : undefined);

  if (vpcId && privateSubnetId && bucketName) {
    new GrootSagemakerStack(app, 'GrootFinetuneSagemaker', {
      stackName: `GrootFinetuneSagemaker${userSuffix}`,
      env,
      userId,
      bucketName,
      vpcId,
      subnetIds: [privateSubnetId],
      availabilityZone,
      mlflowSize: app.node.tryGetContext('mlflowSize') ?? 'Small',
    });
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
