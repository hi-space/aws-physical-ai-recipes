import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { SourceBuildProject } from '../lib/constructs/source-build-project';
import * as iam from 'aws-cdk-lib/aws-iam';

test('a team build is a bounded source snapshot job with one immutable output repository named after the team', () => {
  const stack = new cdk.Stack(new cdk.App(), 'SourceTest', { env: { account: '123456789012', region: 'us-east-1' } });
  const source = new SourceBuildProject(stack, 'Source', { repositoryRoot: path.resolve(__dirname, '../../..'), projectId: 'team-a' });
  const template = Template.fromStack(stack).toJSON();
  const projects = Object.values(template.Resources).filter((value: any) => value.Type === 'AWS::CodeBuild::Project') as any[];
  assert.equal(projects.length, 1);
  assert.equal(projects[0].Properties.Source.Type, 'S3');
  assert.equal(projects[0].Properties.Environment.Image, 'aws/codebuild/standard:7.0');
  assert.equal(projects[0].Properties.ConcurrentBuildLimit, 1);
  assert.equal(projects[0].Properties.TimeoutInMinutes, 20);
  assert.equal(projects[0].Properties.QueuedTimeoutInMinutes, 5);
  assert.match(projects[0].Properties.Source.BuildSpec, /PAI_SOURCE_SHA256/);
  assert.equal(source.target.sourceType, 'S3');
  assert.equal(source.target.outputRepositoryName, 'physical-ai/projects/team-a/source-images');
  assert.equal(projects[0].Properties.Name, 'physical-ai-source-team-a-123456789012');
  const policies = JSON.stringify(Object.values(template.Resources).filter((value: any) => value.Type === 'AWS::IAM::Policy'));
  assert.ok(!policies.includes('s3:ListBucket'));
  assert.ok(!policies.includes('iam:PassRole'));
  assert.ok(!policies.includes('s3:PutObject'));
  assert.ok(policies.includes('s3:GetObjectVersion'));
  const repositories = Object.values(template.Resources).filter((value: any) => value.Type === 'AWS::ECR::Repository') as any[];
  assert.equal(repositories[0].Properties.ImageTagMutability, 'IMMUTABLE');
});
test('CodeBuild read and stop grants use the documented project ARN, never build ARNs', () => {
  const stack = new cdk.Stack(new cdk.App(), 'GrantTest', { env: { account: '123456789012', region: 'us-east-1' } });
  const source = new SourceBuildProject(stack, 'Source', { repositoryRoot: path.resolve(__dirname, '../../..'), projectId: 'team-a' });
  const controller = new iam.Role(stack, 'Controller', { assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com') });
  source.grantControlPlane(controller);
  const resources = Object.values(Template.fromStack(stack).toJSON().Resources) as any[];
  const statements = resources.filter(value => value.Type === 'AWS::IAM::Policy').flatMap(value => value.Properties.PolicyDocument.Statement);
  for (const action of ['codebuild:BatchGetBuilds', 'codebuild:StopBuild']) {
    const statement = statements.find(value => ([] as string[]).concat(value.Action).includes(action));
    assert.ok(statement);
    assert.ok(JSON.stringify(statement.Resource).includes(':project/'));
    assert.ok(!JSON.stringify(statement.Resource).includes(':build/'));
  }
});
