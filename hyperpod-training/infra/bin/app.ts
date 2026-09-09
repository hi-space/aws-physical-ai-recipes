#!/usr/bin/env node
import { execSync } from 'child_process';
import * as cdk from 'aws-cdk-lib';
import { HyperPodStack } from '../lib/hyperpod-stack';
import { HyperPodEksStack } from '../lib/hyperpod-eks-stack';
import { GRAFANA_MODES, GrafanaMode } from '../lib/constructs/observability';
import { DEFAULT_EKS_VERSION, SUPPORTED_EKS_VERSIONS } from '../lib/constructs/eks-control-plane';
import { parseDeploymentProfile } from '../lib/config/deployment-profile';

/**
 * 배포자의 IAM principal ARN. EKS 클러스터 admin 액세스 엔트리에 자동으로 넣어 배포 직후
 * 같은 자격증명으로 kubectl 을 쓸 수 있게 한다. assumed-role 세션(code-server 인스턴스 롤 등)은
 * 롤 ARN 으로 정규화한다 — 액세스 엔트리는 세션이 아니라 롤을 principal 로 받는다.
 */
function resolveCallerPrincipalArn(): string | undefined {
  try {
    const arn = execSync('aws sts get-caller-identity --query Arn --output text', {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
    const m = arn.match(/^arn:aws:sts::(\d{12}):assumed-role\/([^/]+)\//);
    return m ? `arn:aws:iam::${m[1]}:role/${m[2]}` : arn || undefined;
  } catch {
    return undefined;
  }
}

const app = new cdk.App();

// 식별자는 배포 대상 계정 ID(1인 1계정 전제). 스택 이름은 synth 시점에
// literal이어야 하므로 토큰이 아니라 CDK CLI가 주입하는 환경 변수를 읽는다.
const accountId = process.env.CDK_DEFAULT_ACCOUNT ?? '';
const region = app.node.tryGetContext('region') ?? process.env.CDK_DEFAULT_REGION;
const createVpc = (app.node.tryGetContext('createVpc') ?? 'true') === 'true';
const gpuMaxCountPerType = parseInt(app.node.tryGetContext('gpuMaxCount') ?? '4', 10);
const gpuUseSpot = (app.node.tryGetContext('gpuUseSpot') ?? 'false') === 'true';
// GPU 그룹 프로필. 기본 core 는 gpu-g5-8x 하나만 만든다(Workshop Studio SageMaker 허용 목록 호환).
// g6e/g6/p4d/p5 그룹까지 만들려면 -c gpuGroups=extended (해당 타입 cluster 쿼터가 있는 계정용).
const gpuGroups = (app.node.tryGetContext('gpuGroups') ?? 'core') as 'core' | 'extended';
// 배포 프로필. workshop-studio 는 Workshop Studio 이벤트 계정(us-east-1/us-west-2만; head 노드는 personal과 같은 ml.m5.xlarge).
const profile = parseDeploymentProfile(app.node.tryGetContext('profile'));
// 기동할 노드 수. HyperPod Slurm 은 job 제출 시 자동 스케일업하지 않으므로, 학습 전에
// 이 값을 올려 재배포하고 끝나면 0 으로 되돌리는 방식으로 비용을 통제한다.
// gpuCount 는 기본 학습 그룹(TRAIN_INSTANCE_PRESETS.default = ml.g5.8xlarge, gpu-g5-8x)에만 적용된다.
const gpuCount = parseInt(app.node.tryGetContext('gpuCount') ?? '0', 10);
// CPU 그룹(MuJoCo RL, 모듈 9B). cpuCount 는 기본 CPU 학습 그룹(cpu-c5-4x, ml.c5.4xlarge)에만 적용된다.
// GPU cluster 쿼터가 0인 계정(Workshop Studio 이벤트 계정)이 RL 트랙을 끝내는 경로다.
const cpuMaxCountPerType = parseInt(app.node.tryGetContext('cpuMaxCount') ?? '2', 10);
const cpuCount = parseInt(app.node.tryGetContext('cpuCount') ?? '0', 10);
const debugCount = parseInt(app.node.tryGetContext('debugCount') ?? '0', 10);
const fsxCapacityGiB = parseInt(app.node.tryGetContext('fsxCapacityGiB') ?? '1200', 10);
const vpcCidr = app.node.tryGetContext('vpcCidr') ?? '10.0.0.0/16';
// 기존 FSx for Lustre 재사용 (isaaclab 스택의 공유 FSx와 스토리지를 합칠 때 사용).
// Lustre는 같은 VPC에서만 마운트할 수 있으므로 createVpc=false(기존 VPC 합류)와
// 함께 써야 한다. mountName은 `aws fsx describe-file-systems` 로 확인한다.
// 기존 VPC 합류 시 isaaclab VPC는 tag:UserId=<ACCOUNT_ID> 로 찾는다.
const importedFsxId = app.node.tryGetContext('fsxFileSystemId') ?? '';
const importedFsxMountName = app.node.tryGetContext('fsxMountName') ?? '';
// 오케스트레이터. slurm(기본) = HyperPod-<ACCOUNT_ID> Slurm 스택(모듈 8–10),
// eks = HyperPodEks-<ACCOUNT_ID> EKS 스택(모듈 8B/9C: observability, task governance). 두 스택은 공존한다.
const orchestrator = (app.node.tryGetContext('orchestrator') ?? 'slurm') as 'slurm' | 'eks';

if (orchestrator !== 'slurm' && orchestrator !== 'eks') {
  throw new Error(`orchestrator는 'slurm' 또는 'eks' 여야 합니다: '${orchestrator}'`);
}
if (gpuGroups !== 'core' && gpuGroups !== 'extended') {
  throw new Error(`gpuGroups는 'core' 또는 'extended' 여야 합니다: '${gpuGroups}'`);
}
if (!Number.isInteger(gpuCount) || gpuCount < 0 || gpuCount > gpuMaxCountPerType) {
  throw new Error(`gpuCount는 0 이상 gpuMaxCount(${gpuMaxCountPerType}) 이하의 정수여야 합니다: '${gpuCount}'`);
}
if (!Number.isInteger(cpuCount) || cpuCount < 0 || cpuCount > cpuMaxCountPerType) {
  throw new Error(`cpuCount는 0 이상 cpuMaxCount(${cpuMaxCountPerType}) 이하의 정수여야 합니다: '${cpuCount}'`);
}
if (!Number.isInteger(debugCount) || debugCount < 0 || debugCount > 1) {
  throw new Error(`debugCount는 0 또는 1 이어야 합니다: '${debugCount}'`);
}

if ((importedFsxId && !importedFsxMountName) || (!importedFsxId && importedFsxMountName)) {
  throw new Error('fsxFileSystemId와 fsxMountName은 함께 지정해야 합니다.');
}
if (importedFsxId && createVpc) {
  throw new Error(
    'fsxFileSystemId(기존 FSx 재사용)는 같은 VPC에서만 마운트할 수 있습니다. ' +
      '-c createVpc=false 와 함께 지정해 해당 FSx가 있는 VPC(태그 UserId=<ACCOUNT_ID> 매칭)에 합류하세요.',
  );
}

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region,
};

const accountSuffix = accountId ? `-${accountId}` : '';

if (orchestrator === 'eks') {
  // EKS 경로는 personal 프로필 전용: Workshop Studio 이벤트 계정의 허용 서비스 목록에 EKS/AMP/AMG 가 없다.
  if (profile !== 'personal') {
    throw new Error(`orchestrator=eks 는 profile=personal 에서만 배포할 수 있습니다 (지정된 profile: '${profile}').`);
  }
  const eksVersion = String(app.node.tryGetContext('eksVersion') ?? DEFAULT_EKS_VERSION);
  const systemNodeCount = parseInt(app.node.tryGetContext('systemNodeCount') ?? '1', 10);
  const enableObservability = (app.node.tryGetContext('enableObservability') ?? 'true') === 'true';
  const enableTaskGovernance = (app.node.tryGetContext('enableTaskGovernance') ?? 'true') === 'true';
  const deepHealthChecks = (app.node.tryGetContext('deepHealthChecks') ?? 'false') === 'true';
  // Grafana: self-hosted(기본, port-forward) | amg(IAM Identity Center 조직 인스턴스 필요) | none
  const grafanaMode = (app.node.tryGetContext('grafanaMode') ?? 'self-hosted') as GrafanaMode;
  if (!GRAFANA_MODES.includes(grafanaMode)) {
    throw new Error(`grafanaMode는 ${GRAFANA_MODES.join(' | ')} 중 하나여야 합니다: '${grafanaMode}'`);
  }
  const extraAdmins = String(app.node.tryGetContext('eksAdminArns') ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const caller = resolveCallerPrincipalArn();
  const eksAdminArns = Array.from(new Set([...(caller ? [caller] : []), ...extraAdmins]));
  if (eksAdminArns.length === 0) {
    throw new Error('EKS admin principal 을 찾지 못했습니다. AWS 자격증명을 확인하거나 -c eksAdminArns=<role-arn> 을 지정하세요.');
  }
  if (!Number.isInteger(systemNodeCount) || systemNodeCount < 1 || systemNodeCount > 2) {
    throw new Error(`systemNodeCount는 1 또는 2 여야 합니다 (애드온 설치에 노드 1대 이상 필요): '${systemNodeCount}'`);
  }
  if (!(SUPPORTED_EKS_VERSIONS as readonly string[]).includes(eksVersion)) {
    throw new Error(`eksVersion은 ${SUPPORTED_EKS_VERSIONS.join(', ')} 중 하나여야 합니다: '${eksVersion}'`);
  }

  new HyperPodEksStack(app, `HyperPodEks${accountSuffix}`, {
    env,
    accountId,
    vpcCidr,
    eksVersion,
    eksAdminArns,
    gpuMaxCountPerType,
    gpuUseSpot,
    gpuGroups,
    gpuCount,
    systemNodeCount,
    fsxCapacityGiB,
    enableObservability,
    enableTaskGovernance,
    grafanaMode,
    deepHealthChecks,
  });
} else {
const stackName = `HyperPod${accountSuffix}`;

new HyperPodStack(app, stackName, {
  env,
  accountId,
  createVpc,
  vpcCidr,
  gpuMaxCountPerType,
  gpuUseSpot,
  gpuGroups,
  profile,
  gpuCount,
  cpuMaxCountPerType,
  cpuCount,
  debugCount,
  fsxCapacityGiB,
  importedFsxId: importedFsxId || undefined,
  importedFsxMountName: importedFsxMountName || undefined,
});
}
