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

  // userId 미지정 시 계정 ID로 대체한다(계정당 1명 전제). 스택/버킷 이름은 synth
  // 시점에 literal이어야 하므로 토큰이 아니라 CDK CLI가 주입하는 환경 변수를 읽는다.
  // isaaclab 쪽 isaac-lab-app.ts와 동일한 규칙이어야 부모 스택 탐색이 성립한다.
  const userId = (app.node.tryGetContext('userId') as string | undefined)
    ?? process.env.CDK_DEFAULT_ACCOUNT;
  if (!userId) {
    throw new Error(
      'userId를 확정할 수 없습니다. AWS 자격증명을 설정하거나 -c userId=<name>을 지정하세요.',
    );
  }
  const userSuffix = `-${userId}`;

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
  if (missingInfra) {
    // 부모 IsaacLab 스택이 아직 없으면(= shared 먼저 배포하는 단계) per-user 스택을
    // 등록하지 않고 넘어간다. 여기서 throw하면 GrootFinetuneShared 배포도 막힌다.
    console.error(`[GrootFinetune] Resolving parent IsaacLab stack for userId="${userId}" in ${region}...`);
    try {
      const params = await resolveParentStack(userId, region);
      saveToContext({ userId, ...params, region });
      ({ vpcId, efsFileSystemId, efsSecurityGroupId, privateSubnetId, availabilityZone } = params);
      console.error(`[GrootFinetune] Resolved: vpc=${vpcId}, efs=${efsFileSystemId}, az=${availabilityZone}`);
    } catch (err) {
      console.error(`[GrootFinetune] Skipping per-user stacks: ${(err as Error).message}`);
    }
  }

  // ---- [3] Per-user Batch ----
  if (vpcId && efsFileSystemId && efsSecurityGroupId && privateSubnetId && availabilityZone) {
    new GrootBatchTrainStack(app, 'GrootBatchTrain', {
      stackName: `GrootBatchTrain${userSuffix}`,
      env,
      vpcId,
      efsFileSystemId,
      efsSecurityGroupId,
      privateSubnetId,
      availabilityZone,
      userId,
    });
  }

  // ---- [4] Per-user SageMaker ----
  // EFS를 쓰지 않으므로 VPC/Subnet만 확정되면 등록한다.
  if (vpcId && privateSubnetId) {
    new GrootSagemakerStack(app, 'GrootFinetuneSagemaker', {
      stackName: `GrootFinetuneSagemaker${userSuffix}`,
      env,
      userId,
      bucketName: (app.node.tryGetContext('bucketName') as string | undefined)
        ?? `groot-sm-artifacts-${userId}`,
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
