#!/usr/bin/env node
/**
 * Resolves parent stack parameters and writes them to cdk.context.json.
 * Run this before `cdk deploy` if you want auto-resolution:
 *   npx ts-node bin/resolve-parent-stack.ts <userId> [region]
 *
 * Or just use: npm run deploy -- <userId>
 */
import {
  CloudFormationClient,
  DescribeStacksCommand,
} from '@aws-sdk/client-cloudformation';
import { EC2Client, DescribeSubnetsCommand, DescribeSecurityGroupsCommand } from '@aws-sdk/client-ec2';
import * as fs from 'fs';
import * as path from 'path';

async function main() {
  const userId = process.argv[2];
  const region = process.argv[3] ?? process.env.CDK_DEFAULT_REGION ?? 'ap-northeast-2';

  if (!userId) {
    console.error('Usage: npx ts-node bin/resolve-parent-stack.ts <userId> [region]');
    process.exit(1);
  }

  const cfn = new CloudFormationClient({ region });
  const ec2 = new EC2Client({ region });

  const stackName = `IsaacLab-Latest-${userId}`;
  console.log(`Looking up parent stack: ${stackName} in ${region}...`);

  const { Stacks } = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
  if (!Stacks || Stacks.length === 0) {
    console.error(`Parent stack "${stackName}" not found in ${region}`);
    process.exit(1);
  }

  const outputs = Stacks[0].Outputs ?? [];
  const getOutput = (key: string) => outputs.find((o) => o.OutputKey === key)?.OutputValue;

  const efsFileSystemId = getOutput('EfsFileSystemId');
  const privateSubnetId = getOutput('PrivateSubnetId');
  if (!efsFileSystemId || !privateSubnetId) {
    console.error(`Parent stack missing EfsFileSystemId or PrivateSubnetId outputs`);
    process.exit(1);
  }

  // Derive VPC ID and AZ from subnet
  const { Subnets } = await ec2.send(
    new DescribeSubnetsCommand({ SubnetIds: [privateSubnetId] })
  );
  if (!Subnets || Subnets.length === 0) {
    console.error(`Subnet ${privateSubnetId} not found`);
    process.exit(1);
  }
  const vpcId = Subnets[0].VpcId!;
  const availabilityZone = Subnets[0].AvailabilityZone!;

  // Find EFS security group in the VPC (the one that has "for EFS" in description, not "for Batch")
  const { SecurityGroups } = await ec2.send(
    new DescribeSecurityGroupsCommand({
      Filters: [
        { Name: 'vpc-id', Values: [vpcId] },
        { Name: 'description', Values: ['*for EFS*'] },
      ],
    })
  );
  if (!SecurityGroups || SecurityGroups.length === 0) {
    console.error(`No EFS security group found in VPC ${vpcId}. Looking for description containing "for EFS".`);
    process.exit(1);
  }
  const efsSecurityGroupId = SecurityGroups[0].GroupId!;

  // Write to cdk.context.json
  const contextPath = path.join(__dirname, '..', 'cdk.context.json');
  let existing: Record<string, string> = {};
  if (fs.existsSync(contextPath)) {
    existing = JSON.parse(fs.readFileSync(contextPath, 'utf-8'));
  }

  const context = {
    ...existing,
    userId,
    vpcId,
    efsFileSystemId,
    efsSecurityGroupId,
    privateSubnetId,
    availabilityZone,
    region,
    useStableGroot: 'true',
  };

  fs.writeFileSync(contextPath, JSON.stringify(context, null, 2) + '\n');

  console.log('\nResolved parameters:');
  console.log(`  vpcId:              ${vpcId}`);
  console.log(`  efsFileSystemId:    ${efsFileSystemId}`);
  console.log(`  efsSecurityGroupId: ${efsSecurityGroupId}`);
  console.log(`  privateSubnetId:    ${privateSubnetId}`);
  console.log(`  availabilityZone:   ${availabilityZone}`);
  console.log(`\nWritten to: ${contextPath}`);
  console.log('\nNow run: npx cdk deploy');
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
