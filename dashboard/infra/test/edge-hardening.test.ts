import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { DashboardStack } from '../lib/dashboard-stack';

const accountId = '913524902871';
const region = 'us-east-1';

function synthesize() {
  const outputRoot = path.resolve(__dirname, '../cdk.out');
  fs.mkdirSync(outputRoot, { recursive: true });
  const outdir = fs.mkdtempSync(path.join(outputRoot, 'edge-test-'));
  try {
    const app = new cdk.App({ outdir, context: { 'aws:cdk:asset-staging': false } });
    const stack = new DashboardStack(app, 'EdgeHardening', {
      env: { account: accountId, region },
      accountId,
      region,
      discovered: { accountId, region },
      network: {
        vpcId: 'vpc-0123456789abcdef0',
        azs: ['us-east-1a', 'us-east-1b'],
        publicSubnetIds: ['subnet-00000000000000001', 'subnet-00000000000000002'],
        privateSubnetIds: ['subnet-00000000000000003', 'subnet-00000000000000004'],
        vpcCidr: '10.0.0.0/16',
      },
      domainName: 'dashboard.example.com',
      hostedZoneId: 'Z0123456789ABCDEF',
      hostedZoneName: 'example.com',
      adminUsername: 'admin',
      adminEmail: 'admin@example.com',
      webAppPath: path.resolve(__dirname, '../../web'),
      buckets: [],
    });
    return Template.fromStack(stack);
  } finally {
    fs.rmSync(outdir, { recursive: true, force: true });
  }
}

const template = synthesize();

test('no workflow engine resources remain', () => {
  template.resourceCountIs('AWS::StepFunctions::StateMachine', 0);
  template.resourceCountIs('AWS::SQS::Queue', 0);
  template.resourceCountIs('AWS::Events::Rule', 0);
});

test('the ALB is fronted by a regional WAF with managed rules, a rate limit and access logs', () => {
  template.resourceCountIs('AWS::WAFv2::WebACLAssociation', 1);
  template.hasResourceProperties('AWS::WAFv2::WebACL', Match.objectLike({
    Scope: 'REGIONAL',
    DefaultAction: { Allow: {} },
    Rules: Match.arrayWith([
      Match.objectLike({ Name: 'AWSManagedRulesCommonRuleSet', Statement: Match.objectLike({ ManagedRuleGroupStatement: Match.objectLike({
        RuleActionOverrides: [{ Name: 'SizeRestrictions_BODY', ActionToUse: { Count: {} } }] }) }) }),
      Match.objectLike({ Name: 'AWSManagedRulesKnownBadInputsRuleSet' }),
      Match.objectLike({ Name: 'RateLimitPerIp', Action: { Block: {} }, Statement: { RateBasedStatement: { Limit: 2000, AggregateKeyType: 'IP' } } }),
    ]),
  }));
  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', Match.objectLike({
    LoadBalancerAttributes: Match.arrayWith([{ Key: 'access_logs.s3.enabled', Value: 'true' }]),
  }));
});

test('five operational alarms notify the existing SNS topic', () => {
  template.resourceCountIs('AWS::CloudWatch::Alarm', 5);
  const alarms = Object.values(template.findResources('AWS::CloudWatch::Alarm'));
  for (const alarm of alarms) assert.equal(alarm.Properties.AlarmActions.length, 1, 'every alarm must have one action');
  const names = alarms.map(alarm => alarm.Properties.AlarmName).sort();
  assert.deepEqual(names.map((name: string) => name.replace(/^.*-/, '')), ['AlbTarget5xx', 'AlbTargetLatency', 'ControllerReconcileLag', 'ControllerRunningTasks', 'WafBlockedSpike'].sort());
  template.hasResourceProperties('AWS::CloudWatch::Alarm', Match.objectLike({
    Namespace: 'PhysicalAI/Dashboard', MetricName: 'ReconcileLagSeconds', Threshold: 60, TreatMissingData: 'breaching',
  }));
});
