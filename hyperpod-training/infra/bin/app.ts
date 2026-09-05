#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { HyperPodStack } from '../lib/hyperpod-stack';
import { parseDeploymentProfile } from '../lib/config/deployment-profile';

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
const debugCount = parseInt(app.node.tryGetContext('debugCount') ?? '0', 10);
const fsxCapacityGiB = parseInt(app.node.tryGetContext('fsxCapacityGiB') ?? '1200', 10);
const vpcCidr = app.node.tryGetContext('vpcCidr') ?? '10.0.0.0/16';
// 기존 FSx for Lustre 재사용 (isaaclab 스택의 공유 FSx와 스토리지를 합칠 때 사용).
// Lustre는 같은 VPC에서만 마운트할 수 있으므로 createVpc=false(기존 VPC 합류)와
// 함께 써야 한다. mountName은 `aws fsx describe-file-systems` 로 확인한다.
// 기존 VPC 합류 시 isaaclab VPC는 tag:UserId=<ACCOUNT_ID> 로 찾는다.
const importedFsxId = app.node.tryGetContext('fsxFileSystemId') ?? '';
const importedFsxMountName = app.node.tryGetContext('fsxMountName') ?? '';

if (gpuGroups !== 'core' && gpuGroups !== 'extended') {
  throw new Error(`gpuGroups는 'core' 또는 'extended' 여야 합니다: '${gpuGroups}'`);
}
if (!Number.isInteger(gpuCount) || gpuCount < 0 || gpuCount > gpuMaxCountPerType) {
  throw new Error(`gpuCount는 0 이상 gpuMaxCount(${gpuMaxCountPerType}) 이하의 정수여야 합니다: '${gpuCount}'`);
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
  debugCount,
  fsxCapacityGiB,
  importedFsxId: importedFsxId || undefined,
  importedFsxMountName: importedFsxMountName || undefined,
});
