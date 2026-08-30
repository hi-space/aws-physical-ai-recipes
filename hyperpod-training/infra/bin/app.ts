#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { HyperPodStack } from '../lib/hyperpod-stack';

const app = new cdk.App();

// userId 미지정 시 계정 ID를 사용한다(계정당 1명 전제). 스택 이름은 synth 시점에
// literal이어야 하므로 토큰이 아니라 CDK CLI가 주입하는 환경 변수를 읽는다.
const userId = app.node.tryGetContext('userId') ?? process.env.CDK_DEFAULT_ACCOUNT ?? '';
const region = app.node.tryGetContext('region') ?? process.env.CDK_DEFAULT_REGION;
const createVpc = (app.node.tryGetContext('createVpc') ?? 'true') === 'true';
const gpuMaxCountPerType = parseInt(app.node.tryGetContext('gpuMaxCount') ?? '4', 10);
const gpuUseSpot = (app.node.tryGetContext('gpuUseSpot') ?? 'false') === 'true';
// 기동할 노드 수. HyperPod Slurm 은 job 제출 시 자동 스케일업하지 않으므로, 학습 전에
// 이 값을 올려 재배포하고 끝나면 0 으로 되돌리는 방식으로 비용을 통제한다.
// gpuCount 는 기본 학습 그룹(TRAIN_INSTANCE_PRESETS.default = ml.g6e.12xlarge)에만 적용된다.
const gpuCount = parseInt(app.node.tryGetContext('gpuCount') ?? '0', 10);
const debugCount = parseInt(app.node.tryGetContext('debugCount') ?? '0', 10);
const fsxCapacityGiB = parseInt(app.node.tryGetContext('fsxCapacityGiB') ?? '1200', 10);
const vpcCidr = app.node.tryGetContext('vpcCidr') ?? '10.0.0.0/16';

if (userId && !/^[a-z0-9-]+$/.test(userId)) {
  throw new Error(`userId는 영문소문자, 숫자, 하이픈만 허용됩니다: '${userId}'`);
}

if (!Number.isInteger(gpuCount) || gpuCount < 0 || gpuCount > gpuMaxCountPerType) {
  throw new Error(`gpuCount는 0 이상 gpuMaxCount(${gpuMaxCountPerType}) 이하의 정수여야 합니다: '${gpuCount}'`);
}
if (!Number.isInteger(debugCount) || debugCount < 0 || debugCount > 1) {
  throw new Error(`debugCount는 0 또는 1 이어야 합니다: '${debugCount}'`);
}

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region,
};

const userSuffix = userId ? `-${userId}` : '';
const stackName = `HyperPod${userSuffix}`;

new HyperPodStack(app, stackName, {
  env,
  userId,
  createVpc,
  vpcCidr,
  gpuMaxCountPerType,
  gpuUseSpot,
  gpuCount,
  debugCount,
  fsxCapacityGiB,
});
