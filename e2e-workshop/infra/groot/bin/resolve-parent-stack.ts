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
import { EC2Client, DescribeSubnetsCommand, DescribeVpcsCommand } from '@aws-sdk/client-ec2';
import * as fs from 'fs';
import * as path from 'path';

export interface ParentStackParams {
  vpcId: string;
  privateSubnetId: string;
  availabilityZone: string;
  /** VPC CIDR (S3 Files 마운트 타깃 SG 인바운드 소스). */
  vpcCidr: string;
  /** 공유 FSx for Lustre ID. 부모 스택이 -c enableFsx=true 로 배포된 경우에만 존재한다. */
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

  const vpcCidr = await resolveVpcCidr(vpcId, region);

  return { vpcId, privateSubnetId, availabilityZone, vpcCidr, fsxFileSystemId };
}

/**
 * VPC CIDR 조회 (S3 Files 마운트 타깃 SG 의 NFS 인바운드 소스).
 * 부모 스택 Outputs 와 무관하게 VPC ID 만으로 동작하므로, 프로비저너가 IsaacLab 스택 생성 중에
 * `-c vpcId/privateSubnetId/availabilityZone` 을 직접 넘겨 groot 를 먼저 시작하는 경우에도 쓸 수 있다
 * (그 시점에는 스택 Outputs 가 아직 없다). 조회 실패 시 isaaclab 기본 CIDR 로 폴백한다.
 */
export async function resolveVpcCidr(vpcId: string, region: string): Promise<string> {
  const fallback = '10.0.0.0/16';
  try {
    const ec2 = new EC2Client({ region });
    const { Vpcs } = await ec2.send(new DescribeVpcsCommand({ VpcIds: [vpcId] }));
    const cidr = Vpcs?.[0]?.CidrBlock;
    if (cidr) return cidr;
    console.error(`[GrootFinetune] VPC ${vpcId} has no CidrBlock — falling back to ${fallback}`);
  } catch (err) {
    console.error(`[GrootFinetune] DescribeVpcs(${vpcId}) failed (${(err as Error).message}) — falling back to ${fallback}`);
  }
  return fallback;
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
      });
      console.log('Resolved parameters:');
      console.log(`  vpcId:              ${params.vpcId}`);
      console.log(`  privateSubnetId:    ${params.privateSubnetId}`);
      console.log(`  availabilityZone:   ${params.availabilityZone}`);
      console.log(`  vpcCidr:            ${params.vpcCidr}`);
      console.log(`  fsxFileSystemId:    ${params.fsxFileSystemId ?? '(없음 — 부모 스택 enableFsx=false, DRA 생략)'}`);
    })
    .catch((err) => {
      console.error('Error:', err.message);
      process.exit(1);
    });
}
