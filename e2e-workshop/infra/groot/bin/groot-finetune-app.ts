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
 *   npx cdk deploy -c profile=workshop-studio   # Workshop Studio 계정
 *   npx cdk deploy -c enableS3Files=false       # 아티팩트 버킷 S3 Files 마운트 생략
 */
import * as cdk from 'aws-cdk-lib';
import { GrootFinetuneStack } from '../lib/groot-finetune-stack';
import { parseDeploymentProfile } from '../lib/deployment-profile';
import { resolveParentStack, resolveVpcCidr, saveToContext } from './resolve-parent-stack';

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

  const repositoryUrl = app.node.tryGetContext('repositoryUrl') ?? '';
  const profile = parseDeploymentProfile(app.node.tryGetContext('profile'));
  // 아티팩트 버킷 S3 Files 파일시스템 (기본 on). DCV 가 /mnt/s3/groot 로 마운트한다.
  const enableS3Files = (app.node.tryGetContext('enableS3Files') ?? 'true') === 'true';

  // ---- 부모 IsaacLab 스택에서 VPC/EFS/FSx 자동 탐색 ----
  // context로 직접 지정하면(수동 오버라이드) 탐색을 건너뛴다.
  let vpcId = app.node.tryGetContext('vpcId') as string | undefined;
  let privateSubnetId = app.node.tryGetContext('privateSubnetId') as string | undefined;
  let availabilityZone = app.node.tryGetContext('availabilityZone') as string | undefined;
  let fsxFileSystemId = app.node.tryGetContext('fsxFileSystemId') as string | undefined;
  let vpcCidr = app.node.tryGetContext('vpcCidr') as string | undefined;

  // 부모 스택 Outputs 조회는 VPC/서브넷/AZ 가 없을 때만. 프로비저너는 IsaacLab 스택이 아직 생성 중일 때
  // 이 셋을 직접 넘겨 groot 를 먼저 시작하므로(그 시점엔 Outputs 가 없다) vpcCidr 만 빠졌다고 조회하면 안 된다.
  if (!vpcId || !privateSubnetId || !availabilityZone) {
    console.error(`[GrootFinetune] Resolving parent IsaacLab stack (account ${accountId}) in ${region}...`);
    const params = await resolveParentStack(accountId, region);
    saveToContext({ ...params, region });
    ({ vpcId, privateSubnetId, availabilityZone, vpcCidr } = params);
    fsxFileSystemId = fsxFileSystemId ?? params.fsxFileSystemId;
    console.error(`[GrootFinetune] Resolved: vpc=${vpcId} (${vpcCidr}), subnet=${privateSubnetId}, fsx=${fsxFileSystemId ?? '(none)'}, az=${availabilityZone}`);
  } else if (!vpcCidr) {
    // 수동 오버라이드/프로비저너 경로: VPC 는 이미 존재하므로 CIDR 만 DescribeVpcs 로 읽는다 (실패 시 10.0.0.0/16).
    vpcCidr = await resolveVpcCidr(vpcId, region);
    console.error(`[GrootFinetune] vpcCidr for ${vpcId}: ${vpcCidr}`);
  }

  new GrootFinetuneStack(app, 'GrootFinetune', {
    stackName: `GrootFinetune-${accountId}`,
    env,
    accountId,
    // S3 버킷 이름은 글로벌 네임스페이스이므로 리전을 포함해야
    // 같은 계정의 다른 리전 배포와 충돌하지 않는다.
    bucketName: (app.node.tryGetContext('bucketName') as string | undefined)
      ?? `groot-sm-artifacts-${accountId}-${region}`,
    vpcId,
    subnetIds: [privateSubnetId],
    availabilityZone,
    mlflowSize: app.node.tryGetContext('mlflowSize') ?? 'Small',
    fsxFileSystemId,
    enableS3Files,
    vpcCidr,
    repositoryUrl,
    profile,
  });
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
