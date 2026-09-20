#!/usr/bin/env node
/**
 * Physical AI Dashboard — CDK app.
 *
 * Discovers the sibling stacks' outputs at synth time (same runtime-lookup
 * pattern as e2e-workshop/infra/groot/bin/resolve-parent-stack.ts) and passes
 * them to the stack as container environment. Nothing is imported via
 * CloudFormation exports, so the dashboard can be deployed/destroyed
 * independently of the clusters.
 *
 * Context:
 *   -c domainName=physical-ai.example.com   (HTTPS ingress; all three given together)
 *   -c hostedZoneId=Z...  -c hostedZoneName=example.com   (omit all three for HTTP ingress)
 *   -c adminUsername=admin  -c adminEmail=you@example.com  (default admin / admin@<domain>)
 *   -c notifyEmail=you@example.com          (optional SNS subscription)
 *   -c region=us-east-1                     (default CDK_DEFAULT_REGION)
 *   -c vpcId=vpc-...                        (optional override; default: HyperPodEks VPC)
 */
import 'source-map-support/register';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { DescribeSubnetsCommand, DescribeVpcsCommand, EC2Client } from '@aws-sdk/client-ec2';
import { DescribeClusterCommand, EKSClient } from '@aws-sdk/client-eks';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { DashboardStack } from '../lib/dashboard-stack';
import type { DiscoveredOutputs } from '../lib/env-contract';
import { describeModules, resolveModules } from '../lib/modules';

async function stackOutputs(cfn: CloudFormationClient, name: string): Promise<Record<string, string> | undefined> {
  try {
    const out = await cfn.send(new DescribeStacksCommand({ StackName: name }));
    const s = out.Stacks?.[0];
    if (!s || !/COMPLETE$/.test(s.StackStatus ?? '') || s.StackStatus?.startsWith('DELETE')) return undefined;
    const o: Record<string, string> = {};
    for (const x of s.Outputs ?? []) if (x.OutputKey && x.OutputValue) o[x.OutputKey] = x.OutputValue;
    return o;
  } catch (e) {
    if ((e as Error).message?.includes('does not exist')) return undefined;
    throw e;
  }
}

async function main() {
  const app = new cdk.App();
  const modules = resolveModules((k) => app.node.tryGetContext(k));
  cdk.Tags.of(app).add(modules.resourceTag.key, modules.resourceTag.value);
  console.error('[dashboard] modules\n' + describeModules(modules));
  const region =(app.node.tryGetContext('region') as string | undefined) ?? process.env.CDK_DEFAULT_REGION ?? 'us-east-1';
  const sts = new STSClient({ region });
  const accountId = process.env.CDK_DEFAULT_ACCOUNT ?? (await sts.send(new GetCallerIdentityCommand({}))).Account!;
  const cfn = new CloudFormationClient({ region });
  const ec2 = new EC2Client({ region });

  const [hyperPodEks, hyperPodSlurm, groot, isaacLatest, isaacStable] = await Promise.all([
    stackOutputs(cfn, `HyperPodEks-${accountId}`),
    stackOutputs(cfn, `HyperPod-${accountId}`),
    stackOutputs(cfn, `GrootFinetune-${accountId}`),
    stackOutputs(cfn, `IsaacLab-Latest-${accountId}`),
    stackOutputs(cfn, `IsaacLab-Stable-${accountId}`),
  ]);
  const discovered: DiscoveredOutputs = { region, accountId, hyperPodEks, hyperPodSlurm, groot, isaacLab: isaacLatest ?? isaacStable };
  console.error(
    `[dashboard] discovered: HyperPodEks=${Boolean(hyperPodEks)} HyperPod=${Boolean(hyperPodSlurm)} GrootFinetune=${Boolean(groot)} IsaacLab=${Boolean(isaacLatest ?? isaacStable)}`,
  );

  const vpcId = (app.node.tryGetContext('vpcId') as string | undefined) ?? hyperPodEks?.VpcId ?? hyperPodSlurm?.VpcId ?? (isaacLatest ?? isaacStable)?.VpcId;
  if (!vpcId) throw new Error('No VPC found: deploy HyperPodEks-<acct> (recommended) or pass -c vpcId=');
  const subnets = (await ec2.send(new DescribeSubnetsCommand({ Filters: [{ Name: 'vpc-id', Values: [vpcId] }] }))).Subnets ?? [];
  const vpcCidr = (await ec2.send(new DescribeVpcsCommand({ VpcIds: [vpcId] }))).Vpcs?.[0]?.CidrBlock;
  const publicSubnets = subnets.filter((s) => s.MapPublicIpOnLaunch || /public/i.test(s.Tags?.find((t) => t.Key === 'Name')?.Value ?? ''));
  const privateSubnets = subnets.filter((s) => !publicSubnets.includes(s));
  if (publicSubnets.length < 2) throw new Error(`VPC ${vpcId} needs at least two public subnets for the ALB (found ${publicSubnets.length})`);
  if (!privateSubnets.length) throw new Error(`VPC ${vpcId} has no private subnets for the Fargate task`);
  // Keep one subnet per AZ, same AZ ordering for public/private.
  const azs = [...new Set(publicSubnets.map((s) => s.AvailabilityZone!))].sort();
  const pick = (list: typeof subnets) => azs.map((az) => list.find((s) => s.AvailabilityZone === az)?.SubnetId).filter(Boolean) as string[];
  const network = { vpcId, azs, publicSubnetIds: pick(publicSubnets), privateSubnetIds: pick(privateSubnets), vpcCidr };
  if (network.privateSubnetIds.length !== azs.length) {
    // Private subnets may not cover every public AZ; trim to the intersection.
    const common = azs.filter((az) => privateSubnets.some((s) => s.AvailabilityZone === az));
    network.azs = common;
    network.publicSubnetIds = common.map((az) => publicSubnets.find((s) => s.AvailabilityZone === az)!.SubnetId!);
    network.privateSubnetIds = common.map((az) => privateSubnets.find((s) => s.AvailabilityZone === az)!.SubnetId!);
  }

  const domainName = modules.ingress.mode === 'https' ? modules.ingress.domainName : '';
  const hostedZoneId = modules.ingress.mode === 'https' ? modules.ingress.hostedZoneId : '';
  const hostedZoneName = modules.ingress.mode === 'https' ? modules.ingress.hostedZoneName : '';

  const buckets = [hyperPodEks?.S3BucketName, groot?.BucketName, hyperPodSlurm?.S3BucketName].filter(Boolean) as string[];

  // The EKS control-plane ENIs sit behind the cluster security group; the Fargate task must be allowed in on 443
  // or every Kubernetes call from inside the VPC times out (DNS resolves the private endpoint).
  let eksClusterSecurityGroupId: string | undefined;
  if (hyperPodEks?.EksClusterName) {
    const eksOut = await new EKSClient({ region }).send(new DescribeClusterCommand({ name: hyperPodEks.EksClusterName }));
    eksClusterSecurityGroupId = eksOut.cluster?.resourcesVpcConfig?.clusterSecurityGroupId;
  }

  new DashboardStack(app, 'PhysicalAiDashboard', {
    stackName: `PhysicalAiDashboard-${accountId}`,
    env: { account: accountId, region },
    description: 'Physical AI Dashboard: OSMO-style control plane for HyperPod EKS / SageMaker / DCV / Greengrass (Next.js on Fargate, ALB + Cognito)',
    accountId,
    region,
    discovered,
    network,
    domainName,
    hostedZoneId,
    hostedZoneName,
    modules,
    adminUsername: (app.node.tryGetContext('adminUsername') as string | undefined) ?? 'admin',
    adminEmail: (app.node.tryGetContext('adminEmail') as string | undefined) ?? (modules.ingress.mode === 'https' ? `admin@${modules.ingress.hostedZoneName}` : 'admin@example.invalid'),
    notifyEmail: app.node.tryGetContext('notifyEmail') as string | undefined,
    webAppPath: path.resolve(__dirname, '..', '..', 'web'),
    buckets,
    eksClusterSecurityGroupId,
    extendedImages: modules.images.build.includes('groot'),
    workflowNamespaces: ((app.node.tryGetContext('workflowNamespaces') as string | undefined) ?? 'hyperpod-ns-team-a,hyperpod-ns-team-b').split(',').map((value) => value.trim()).filter(Boolean),
    mlflowTrackingServerArns: [groot?.MlflowTrackingServerArn, hyperPodEks?.MlflowTrackingArn].filter(Boolean) as string[],
  });
  app.synth();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
