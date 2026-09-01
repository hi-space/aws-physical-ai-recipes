#!/usr/bin/env node
/**
 * Resolves parent IsaacLab stack parameters (VPC/Subnet/AZ/FSx).
 *
 * Importable: `resolveParentStack(accountId, region)` — used by groot-finetune-app.ts
 * Standalone: `npx ts-node bin/resolve-parent-stack.ts [accountId] [region]` — writes cdk.context.json
 *   accountId 생략 시 CDK_DEFAULT_ACCOUNT를 사용한다(1인 1계정 전제).
 */
import {
  CloudFormationClient,
  DescribeStacksCommand,
} from '@aws-sdk/client-cloudformation';
import { EC2Client, DescribeSubnetsCommand } from '@aws-sdk/client-ec2';
import * as fs from 'fs';
import * as path from 'path';

export interface ParentStackParams {
  vpcId: string;
  privateSubnetId: string;
  availabilityZone: string;
  /** 공유 FSx for Lustre ID. 구버전 부모 스택(FSx 도입 전)에는 없을 수 있다. */
  fsxFileSystemId?: string;
}

export async function resolveParentStack(accountId: string, region: string): Promise<ParentStackParams> {
  const cfn = new CloudFormationClient({ region });
  const ec2 = new EC2Client({ region });

  // suffix 없는 이름은 계정 ID suffix 도입 전에 배포된 스택을 위한 fallback.
  const candidates = accountId
    ? [`IsaacLab-Latest-${accountId}`, `IsaacLab-Stable-${accountId}`, 'IsaacLab-Latest', 'IsaacLab-Stable']
    : ['IsaacLab-Latest', 'IsaacLab-Stable'];

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
      `No parent IsaacLab stack found in ${region} (account ${accountId}). Tried: ${candidates.join(', ')}. 모듈 1의 IsaacLab 스택을 먼저 배포하세요.`,
    );
  }

  const getOutput = (key: string) => outputs.find((o) => o.OutputKey === key)?.OutputValue;
  const privateSubnetId = getOutput('PrivateSubnetId');
  const fsxFileSystemId = getOutput('FsxFileSystemId');

  if (!privateSubnetId) {
    throw new Error(`Parent stack ${foundStack} missing PrivateSubnetId output`);
  }

  const { Subnets } = await ec2.send(new DescribeSubnetsCommand({ SubnetIds: [privateSubnetId] }));
  if (!Subnets || Subnets.length === 0) throw new Error(`Subnet ${privateSubnetId} not found`);
  const vpcId = Subnets[0].VpcId!;
  const availabilityZone = Subnets[0].AvailabilityZone!;

  return { vpcId, privateSubnetId, availabilityZone, fsxFileSystemId };
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
  const accountId = process.argv[2] ?? process.env.CDK_DEFAULT_ACCOUNT ?? '';
  const region = process.argv[3] ?? process.env.CDK_DEFAULT_REGION ?? 'us-east-1';

  resolveParentStack(accountId, region)
    .then((params) => {
      const { fsxFileSystemId, ...required } = params;
      saveToContext({
        ...required,
        ...(fsxFileSystemId ? { fsxFileSystemId } : {}),
        region,
        useStableGroot: 'true',
      });
      console.log('Resolved parameters:');
      console.log(`  vpcId:              ${params.vpcId}`);
      console.log(`  privateSubnetId:    ${params.privateSubnetId}`);
      console.log(`  availabilityZone:   ${params.availabilityZone}`);
      console.log(`  fsxFileSystemId:    ${params.fsxFileSystemId ?? '(없음 — 부모 스택에 FSx 미배포)'}`);
    })
    .catch((err) => {
      console.error('Error:', err.message);
      process.exit(1);
    });
}
