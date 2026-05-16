#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { OsmoStack } from '../lib/osmo-stack';

const app = new cdk.App();

const userId = app.node.tryGetContext('userId') ?? '';
const region = app.node.tryGetContext('region') ?? 'us-east-1';
const vpcCidr = app.node.tryGetContext('vpcCidr') ?? '10.0.0.0/16';
const gpuSimMaxNodes = parseInt(app.node.tryGetContext('gpuSimMaxNodes') ?? '8', 10);
const gpuTrainMaxNodes = parseInt(app.node.tryGetContext('gpuTrainMaxNodes') ?? '4', 10);

if (userId && !/^[a-z0-9-]+$/.test(userId)) {
  throw new Error(`userId는 영문소문자, 숫자, 하이픈만 허용됩니다: '${userId}'`);
}

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region,
};

const userSuffix = userId ? `-${userId}` : '';
const stackName = `Osmo${userSuffix}`;

new OsmoStack(app, stackName, {
  env,
  userId,
  vpcCidr,
  gpuSimMaxNodes,
  gpuTrainMaxNodes,
});
