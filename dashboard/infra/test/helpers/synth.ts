import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { DashboardStack, type DashboardStackProps } from '../../lib/dashboard-stack';

export const ACCOUNT = '913524902871', REGION = 'us-east-1';
export function synthesize(overrides: Partial<DashboardStackProps> & { context?: Record<string, unknown> } = {}): Template {
  const outputRoot = path.resolve(__dirname, '../../cdk.out');
  fs.mkdirSync(outputRoot, { recursive: true });
  const outdir = fs.mkdtempSync(path.join(outputRoot, 'module-test-'));
  try {
    const { context, ...props } = overrides;
    const app = new cdk.App({ outdir, context: { 'aws:cdk:asset-staging': false, ...(context ?? {}) } });
    const stack = new DashboardStack(app, 'ModuleTest', {
      env: { account: ACCOUNT, region: REGION }, accountId: ACCOUNT, region: REGION,
      discovered: { accountId: ACCOUNT, region: REGION },
      network: { vpcId: 'vpc-0123456789abcdef0', azs: ['us-east-1a', 'us-east-1b'],
        publicSubnetIds: ['subnet-00000000000000001', 'subnet-00000000000000002'],
        privateSubnetIds: ['subnet-00000000000000003', 'subnet-00000000000000004'], vpcCidr: '10.0.0.0/16' },
      domainName: 'dashboard.example.com', hostedZoneId: 'Z0123456789ABCDEF', hostedZoneName: 'example.com',
      adminUsername: 'admin', adminEmail: 'admin@example.com',
      webAppPath: path.resolve(__dirname, '../../../web'), buckets: [],
      ...props,
    });
    return Template.fromStack(stack);
  } finally { fs.rmSync(outdir, { recursive: true, force: true }); }
}
export const logicalIds = (t: Template) => Object.keys(t.toJSON().Resources ?? {}).sort();
