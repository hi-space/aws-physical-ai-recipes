#!/usr/bin/env node
/**
 * Resolves parent IsaacLab stack parameters (VPC/EFS/Subnet/AZ).
 *
 * Importable: `resolveParentStack(userId, region)` — used by groot-batch-train-app.ts
 * Standalone: `npx ts-node bin/resolve-parent-stack.ts <userId> [region]` — writes cdk.context.json
 */
import {
  CloudFormationClient,
  DescribeStacksCommand,
} from '@aws-sdk/client-cloudformation';
import { EC2Client, DescribeSubnetsCommand, DescribeSecurityGroupsCommand } from '@aws-sdk/client-ec2';
import * as fs from 'fs';
import * as path from 'path';

export interface ParentStackParams {
  vpcId: string;
  efsFileSystemId: string;
  efsSecurityGroupId: string;
  privateSubnetId: string;
  availabilityZone: string;
}

export async function resolveParentStack(userId: string, region: string): Promise<ParentStackParams> {
  const cfn = new CloudFormationClient({ region });
  const ec2 = new EC2Client({ region });

  const candidates = [
    `IsaacLab-Latest-${userId}`,
    `IsaacLab-Stable-${userId}`,
  ];

  let foundStack: string | undefined;
  let outputs: Array<{ OutputKey?: string; OutputValue?: string }> = [];

  for (const candidate of candidates) {
    try {
      const result = await cfn.send(new DescribeStacksCommand({ StackName: candidate }));
      if (result.Stacks && result.Stacks.length > 0) {
        foundStack = candidate;
        outputs = result.Stacks[0].Outputs ?? [];
        break;
      }
    } catch (err: unknown) {
      const e = err as { name?: string; message?: string };
      if (e.name === 'ValidationError' || e.message?.includes('does not exist')) continue;
      throw err;
    }
  }

  if (!foundStack) {
    throw new Error(
      `No parent stack found for userId "${userId}" in ${region}. Tried: ${candidates.join(', ')}`,
    );
  }

  const getOutput = (key: string) => outputs.find((o) => o.OutputKey === key)?.OutputValue;
  const efsFileSystemId = getOutput('EfsFileSystemId');
  const privateSubnetId = getOutput('PrivateSubnetId');

  if (!efsFileSystemId || !privateSubnetId) {
    throw new Error(`Parent stack ${foundStack} missing EfsFileSystemId or PrivateSubnetId outputs`);
  }

  const { Subnets } = await ec2.send(new DescribeSubnetsCommand({ SubnetIds: [privateSubnetId] }));
  if (!Subnets || Subnets.length === 0) throw new Error(`Subnet ${privateSubnetId} not found`);
  const vpcId = Subnets[0].VpcId!;
  const availabilityZone = Subnets[0].AvailabilityZone!;

  const { SecurityGroups } = await ec2.send(new DescribeSecurityGroupsCommand({
    Filters: [
      { Name: 'vpc-id', Values: [vpcId] },
      { Name: 'description', Values: ['*for EFS*'] },
    ],
  }));
  if (!SecurityGroups || SecurityGroups.length === 0) {
    throw new Error(`No EFS security group found in VPC ${vpcId}`);
  }
  const efsSecurityGroupId = SecurityGroups[0].GroupId!;

  return { vpcId, efsFileSystemId, efsSecurityGroupId, privateSubnetId, availabilityZone };
}

export function saveToContext(values: Record<string, string>): void {
  const contextPath = path.join(__dirname, '..', 'cdk.context.json');
  let existing: Record<string, string> = {};
  if (fs.existsSync(contextPath)) {
    existing = JSON.parse(fs.readFileSync(contextPath, 'utf-8'));
  }
  fs.writeFileSync(contextPath, JSON.stringify({ ...existing, ...values }, null, 2) + '\n');
}

if (require.main === module) {
  const userId = process.argv[2];
  const region = process.argv[3] ?? process.env.CDK_DEFAULT_REGION ?? 'us-east-1';

  if (!userId) {
    console.error('Usage: npx ts-node bin/resolve-parent-stack.ts <userId> [region]');
    process.exit(1);
  }

  resolveParentStack(userId, region)
    .then((params) => {
      saveToContext({ userId, ...params, region, useStableGroot: 'true' });
      console.log('Resolved parameters:');
      console.log(`  vpcId:              ${params.vpcId}`);
      console.log(`  efsFileSystemId:    ${params.efsFileSystemId}`);
      console.log(`  efsSecurityGroupId: ${params.efsSecurityGroupId}`);
      console.log(`  privateSubnetId:    ${params.privateSubnetId}`);
      console.log(`  availabilityZone:   ${params.availabilityZone}`);
    })
    .catch((err) => {
      console.error('Error:', err.message);
      process.exit(1);
    });
}
