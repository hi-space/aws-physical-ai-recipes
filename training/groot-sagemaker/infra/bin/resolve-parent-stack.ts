#!/usr/bin/env node
/**
 * IsaacLab 부모 스택의 VPC/Subnet을 조회해 cdk.context.json에 기록합니다.
 *   - IsaacLab-Latest-${alias} 또는 IsaacLab-Stable-${alias} 스택에서 PrivateSubnetId Output을 읽음
 *   - subnet 정보로부터 vpcId / availabilityZone 도출
 *   - cdk.context.json 에 vpcId, subnetIds, alias 등을 캐시
 *
 * 사용법:
 *   npx ts-node bin/resolve-parent-stack.ts <alias> [region]
 *
 * 이후 `npx cdk deploy` 만 실행하면 cdk.context.json의 값을 자동으로 사용합니다.
 */
import {
  CloudFormationClient,
  DescribeStacksCommand,
} from '@aws-sdk/client-cloudformation';
import {
  DescribeSubnetsCommand,
  EC2Client,
} from '@aws-sdk/client-ec2';
import * as fs from 'fs';
import * as path from 'path';

async function main() {
  const alias = process.argv[2];
  const region =
    process.argv[3] ?? process.env.CDK_DEFAULT_REGION ?? process.env.AWS_REGION ?? 'us-east-1';

  if (!alias) {
    console.error('Usage: npx ts-node bin/resolve-parent-stack.ts <alias> [region]');
    process.exit(1);
  }

  const cfn = new CloudFormationClient({ region });
  const ec2 = new EC2Client({ region });

  const candidates = [`IsaacLab-Latest-${alias}`, `IsaacLab-Stable-${alias}`];
  let foundStack: string | undefined;
  let privateSubnetId: string | undefined;

  for (const stackName of candidates) {
    console.log(`부모 스택 시도: ${stackName} (${region})`);
    try {
      const resp = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
      const stack = resp.Stacks?.[0];
      if (!stack) continue;
      const value = stack.Outputs?.find((o) => o.OutputKey === 'PrivateSubnetId')?.OutputValue;
      if (value) {
        foundStack = stackName;
        privateSubnetId = value;
        break;
      }
    } catch (err: any) {
      if (
        err?.name === 'ValidationError' ||
        String(err?.message ?? '').includes('does not exist')
      ) {
        continue;
      }
      throw err;
    }
  }

  if (!foundStack || !privateSubnetId) {
    console.error(
      `\nIsaacLab 부모 스택을 찾지 못했습니다. 시도한 이름: ${candidates.join(', ')}\n` +
        `대안: vpcId/subnetIds 를 직접 지정\n` +
        `  npx cdk deploy -c alias=${alias} -c bucketName=... -c vpcId=vpc-xxx -c subnetIds=subnet-a,subnet-b`,
    );
    process.exit(1);
  }
  console.log(`부모 스택 발견: ${foundStack}, PrivateSubnetId=${privateSubnetId}`);

  const { Subnets } = await ec2.send(
    new DescribeSubnetsCommand({ SubnetIds: [privateSubnetId] }),
  );
  if (!Subnets || Subnets.length === 0) {
    console.error(`Subnet ${privateSubnetId} 을(를) 찾을 수 없습니다.`);
    process.exit(1);
  }
  const vpcId = Subnets[0].VpcId!;
  const availabilityZone = Subnets[0].AvailabilityZone!;

  // cdk.context.json 갱신
  const contextPath = path.join(__dirname, '..', 'cdk.context.json');
  let existing: Record<string, unknown> = {};
  if (fs.existsSync(contextPath)) {
    existing = JSON.parse(fs.readFileSync(contextPath, 'utf-8'));
  }
  const merged = {
    ...existing,
    alias,
    region,
    vpcId,
    subnetIds: privateSubnetId,
    availabilityZone,
  };
  fs.writeFileSync(contextPath, JSON.stringify(merged, null, 2) + '\n');

  console.log('\n해석된 파라미터:');
  console.log(`  alias            : ${alias}`);
  console.log(`  region           : ${region}`);
  console.log(`  vpcId            : ${vpcId}`);
  console.log(`  subnetIds        : ${privateSubnetId}`);
  console.log(`  availabilityZone : ${availabilityZone}`);
  console.log(`\ncdk.context.json 갱신: ${contextPath}`);
  console.log('\n다음 단계:');
  console.log(`  npx cdk deploy -c bucketName=groot-sm-training-${alias}`);
}

main().catch((err) => {
  console.error('오류:', err?.message ?? err);
  process.exit(1);
});
