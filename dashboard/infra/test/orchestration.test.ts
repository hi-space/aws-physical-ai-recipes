import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { OrchestrationConstruct } from '../lib/constructs/orchestration';

test('workflows use a durable callback, encrypted queues and retained state', () => {
  const stack = new cdk.Stack(new cdk.App(), 'Test', { env: { account: '123456789012', region: 'us-east-1' } });
  new OrchestrationConstruct(stack, 'Engine');
  const template = Template.fromStack(stack);
  template.resourceCountIs('AWS::StepFunctions::StateMachine', 1);
  template.hasResourceProperties('AWS::SQS::Queue', { SqsManagedSseEnabled: true, RedrivePolicy: Match.objectLike({ maxReceiveCount: 5 }) });
  template.hasResource('AWS::DynamoDB::Table', { DeletionPolicy: 'Retain', Properties: Match.objectLike({ TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true } }) });
  template.hasResourceProperties('AWS::S3::Bucket', {
    VersioningConfiguration: { Status: 'Enabled' },
    PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
  });
  const resources = template.findResources('AWS::StepFunctions::StateMachine');
  const definition = Object.values(resources)[0].Properties.DefinitionString;
  const json = typeof definition === 'string' ? definition
    : definition['Fn::Join'][1].map((part: unknown) => typeof part === 'string' ? part : 'resolved-token').join('');
  const state = JSON.parse(json).States.DispatchWorkflow;
  assert.match(state.Resource, /sqs:sendMessage\.waitForTaskToken$/);
  assert.equal(state.HeartbeatSeconds, 300);
});
