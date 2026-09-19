import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { ArtifactsConstruct } from '../lib/constructs/artifacts';

test('artifacts construct owns only the versioned, private bucket and keeps its logical id', () => {
  const stack = new cdk.Stack(new cdk.App(), 'Test', { env: { account: '123456789012', region: 'us-east-1' } });
  new ArtifactsConstruct(stack, 'Orchestration');
  const template = Template.fromStack(stack);
  template.resourceCountIs('AWS::StepFunctions::StateMachine', 0);
  template.resourceCountIs('AWS::SQS::Queue', 0);
  template.resourceCountIs('AWS::DynamoDB::Table', 0);
  template.resourceCountIs('AWS::Events::Rule', 0);
  template.resourceCountIs('AWS::S3::Bucket', 1);
  template.hasResource('AWS::S3::Bucket', {
    DeletionPolicy: 'Retain',
    Properties: Match.objectLike({
      VersioningConfiguration: { Status: 'Enabled' },
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
    }),
  });
  const [logicalId] = Object.keys(template.findResources('AWS::S3::Bucket'));
  assert.match(logicalId, /^OrchestrationArtifacts/);
});

test('artifact objects tier down after 30 days and superseded versions expire after 90', () => {
  const stack = new cdk.Stack(new cdk.App(), 'Lifecycle', { env: { account: '123456789012', region: 'us-east-1' } });
  new ArtifactsConstruct(stack, 'Orchestration');
  Template.fromStack(stack).hasResourceProperties('AWS::S3::Bucket', Match.objectLike({
    LifecycleConfiguration: { Rules: Match.arrayWith([
      Match.objectLike({ Status: 'Enabled', Transitions: [{ StorageClass: 'INTELLIGENT_TIERING', TransitionInDays: 30 }], NoncurrentVersionExpiration: { NoncurrentDays: 90 } }),
      Match.objectLike({ Status: 'Enabled', AbortIncompleteMultipartUpload: { DaysAfterInitiation: 2 } }),
    ]) },
  }));
});
