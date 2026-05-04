#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { GrootFinetuneStack } from '../lib/groot-finetune-stack';

const app = new cdk.App();

// Required: userId (the only mandatory parameter)
const userId = app.node.tryGetContext('userId');
if (!userId) {
  throw new Error(
    'Required: -c userId=<your-id>\n\n' +
    'Quick start (auto-resolve from parent stack):\n' +
    '  npx ts-node bin/resolve-parent-stack.ts <userId>\n' +
    '  npx cdk deploy\n\n' +
    'Or provide all parameters manually:\n' +
    '  cdk deploy -c userId=alice -c vpcId=vpc-xxx -c efsFileSystemId=fs-xxx \\\n' +
    '    -c efsSecurityGroupId=sg-xxx -c privateSubnetId=subnet-xxx -c availabilityZone=us-east-1a'
  );
}

// These come from cdk.context.json (auto-resolved) or -c flags (manual)
const vpcId = app.node.tryGetContext('vpcId');
const efsFileSystemId = app.node.tryGetContext('efsFileSystemId');
const efsSecurityGroupId = app.node.tryGetContext('efsSecurityGroupId');
const privateSubnetId = app.node.tryGetContext('privateSubnetId');
const availabilityZone = app.node.tryGetContext('availabilityZone');

if (!vpcId || !efsFileSystemId || !efsSecurityGroupId || !privateSubnetId || !availabilityZone) {
  throw new Error(
    'Missing infrastructure parameters.\n\n' +
    'Run auto-resolution first:\n' +
    `  npx ts-node bin/resolve-parent-stack.ts ${userId}\n\n` +
    'This will look up IsaacLab-Latest/Stable-' + userId + ' and write parameters to cdk.context.json.'
  );
}

// Optional parameters
const useStableGroot = (app.node.tryGetContext('useStableGroot') ?? 'true') === 'true';
const region = app.node.tryGetContext('region') ?? process.env.CDK_DEFAULT_REGION ?? 'us-east-1';

const stackName = `GrootFinetune-${userId}`;

new GrootFinetuneStack(app, stackName, {
  stackName,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region,
  },
  vpcId,
  efsFileSystemId,
  efsSecurityGroupId,
  privateSubnetId,
  availabilityZone,
  userId,
  useStableGroot,
});
