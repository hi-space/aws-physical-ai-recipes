#!/usr/bin/env node
/**
 * GR00T 파인튜닝 인프라 CDK App (단일 스택, 1인 1계정 전제).
 *
 * 스택 이름: GrootFinetune-<ACCOUNT_ID>
 *
 * 부모 IsaacLab 스택(IsaacLab-Latest-<ACCOUNT_ID> 등)에서 VPC/Subnet/FSx를
 * 자동 탐색(resolve)해 cdk.context.json에 캐시한다. 부모 스택이 없으면 배포할 수
 * 없다 — 모듈 1의 IsaacLab 인프라를 먼저 배포할 것.
 *
 * 사용 예시:
 *   npm run deploy                        # GrootFinetune-<ACCOUNT_ID> 배포
 *   npx cdk deploy -c grootVersion=n1.7   # GR00T N1.7 런타임 이미지
 */
import * as cdk from 'aws-cdk-lib';
import { GrootFinetuneStack } from '../lib/groot-finetune-stack';
import { resolveParentStack, saveToContext } from './resolve-parent-stack';

async function main() {
  const app = new cdk.App();

  const region = app.node.tryGetContext('region') ?? process.env.CDK_DEFAULT_REGION ?? 'us-east-1';
  const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region };

  // 식별자는 배포 대상 계정 ID(1인 1계정 전제). 스택/버킷 이름은 synth 시점에
  // literal이어야 하므로 토큰이 아니라 CDK CLI가 주입하는 환경 변수를 읽는다.
  // isaaclab 쪽 isaac-lab-app.ts와 동일한 규칙이어야 부모 스택 탐색이 성립한다.
  const accountId = process.env.CDK_DEFAULT_ACCOUNT;
  if (!accountId) {
    throw new Error('계정 ID를 확정할 수 없습니다. AWS 자격증명을 설정하세요.');
  }

  const useStableGroot = (app.node.tryGetContext('useStableGroot') ?? 'true') === 'true';
  const grootVersion = app.node.tryGetContext('grootVersion') ?? 'n1.6';
  const repositoryUrl = app.node.tryGetContext('repositoryUrl') ?? '';

  // ---- 부모 IsaacLab 스택에서 VPC/EFS/FSx 자동 탐색 ----
  // context로 직접 지정하면(수동 오버라이드) 탐색을 건너뛴다.
  let vpcId = app.node.tryGetContext('vpcId') as string | undefined;
  let privateSubnetId = app.node.tryGetContext('privateSubnetId') as string | undefined;
  let availabilityZone = app.node.tryGetContext('availabilityZone') as string | undefined;
  let fsxFileSystemId = app.node.tryGetContext('fsxFileSystemId') as string | undefined;

  if (!vpcId || !privateSubnetId || !availabilityZone) {
    console.error(`[GrootFinetune] Resolving parent IsaacLab stack (account ${accountId}) in ${region}...`);
    const params = await resolveParentStack(accountId, region);
    saveToContext({ ...params, region });
    ({ vpcId, privateSubnetId, availabilityZone } = params);
    fsxFileSystemId = fsxFileSystemId ?? params.fsxFileSystemId;
    console.error(`[GrootFinetune] Resolved: vpc=${vpcId}, subnet=${privateSubnetId}, fsx=${fsxFileSystemId ?? '(none)'}, az=${availabilityZone}`);
  }

  new GrootFinetuneStack(app, 'GrootFinetune', {
    stackName: `GrootFinetune-${accountId}`,
    env,
    accountId,
    bucketName: (app.node.tryGetContext('bucketName') as string | undefined)
      ?? `groot-sm-artifacts-${accountId}`,
    vpcId,
    subnetIds: [privateSubnetId],
    availabilityZone,
    mlflowSize: app.node.tryGetContext('mlflowSize') ?? 'Small',
    fsxFileSystemId,
    useStableGroot,
    grootVersion,
    repositoryUrl,
  });
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
