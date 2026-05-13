import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

export interface VpcResolverInput {
  alias: string;
  vpcId?: string;
  subnetIds?: string[];
  /** resolve-parent-stack.ts 가 캐시한 단일 AZ. fromVpcAttributes 의 availabilityZones 로 사용. */
  availabilityZone?: string;
}

export interface VpcResolverResult {
  vpc: ec2.IVpc;
  subnetIds: string[];
}

/**
 * VPC / Subnet 결정 우선순위:
 *   1) -c vpcId + -c subnetIds 명시값 → 그대로 사용
 *      (또는 bin/resolve-parent-stack.ts 가 cdk.context.json 에 캐시한 IsaacLab 부모 스택 값)
 *   2) 계정 default VPC 자동 탐지 (synth-time lookup)
 */
export function resolveVpcAndSubnets(
  scope: Construct,
  input: VpcResolverInput,
): VpcResolverResult {
  if (input.vpcId && input.subnetIds && input.subnetIds.length > 0) {
    const azs = input.availabilityZone
      ? [input.availabilityZone]
      : cdk.Stack.of(scope).availabilityZones;
    const vpc = ec2.Vpc.fromVpcAttributes(scope, 'ImportedVpc', {
      vpcId: input.vpcId,
      availabilityZones: azs,
    });
    return { vpc, subnetIds: input.subnetIds };
  }

  // Default VPC + 그 안의 모든 subnet (synth-time lookup)
  const vpc = ec2.Vpc.fromLookup(scope, 'DefaultVpc', { isDefault: true });
  // Public + Private + Isolated 모두 포함하여 Studio 도메인용 subnet 후보 제공
  const subnetIds = [
    ...vpc.publicSubnets.map((s) => s.subnetId),
    ...vpc.privateSubnets.map((s) => s.subnetId),
    ...vpc.isolatedSubnets.map((s) => s.subnetId),
  ];
  if (subnetIds.length === 0) {
    throw new Error(
      'Default VPC에서 subnet을 찾을 수 없습니다. -c vpcId / -c subnetIds 를 명시하세요.',
    );
  }
  return { vpc, subnetIds };
}
