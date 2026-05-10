#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { HyperPodStack } from '../lib/hyperpod-stack';

const app = new cdk.App();

const userId = app.node.tryGetContext('userId') ?? '';
const region = app.node.tryGetContext('region') ?? process.env.CDK_DEFAULT_REGION;
const createVpc = (app.node.tryGetContext('createVpc') ?? 'true') === 'true';
const gpuMaxCountPerType = parseInt(app.node.tryGetContext('gpuMaxCount') ?? '4', 10);
const gpuUseSpot = (app.node.tryGetContext('gpuUseSpot') ?? 'false') === 'true';
const fsxCapacityGiB = parseInt(app.node.tryGetContext('fsxCapacityGiB') ?? '1200', 10);
const vpcCidr = app.node.tryGetContext('vpcCidr') ?? '10.0.0.0/16';

if (userId && !/^[a-z0-9-]+$/.test(userId)) {
  throw new Error(`userId는 영문소문자, 숫자, 하이픈만 허용됩니다: '${userId}'`);
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
  fsxCapacityGiB,
});
