import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { DashboardStack } from '../lib/dashboard-stack';
import type { DiscoveredOutputs } from '../lib/env-contract';

const accountId = '913524902871';
const region = 'us-east-1';
const sageMakerRoleArn = 'arn:aws:iam::913524902871:role/groot-sagemaker';
const grootOutputs = {
  BucketName: 'groot-artifacts-913524902871',
  SageMakerRoleArn: sageMakerRoleArn,
  TrainingRepositoryUri: '913524902871.dkr.ecr.us-east-1.amazonaws.com/groot-training',
};

interface Statement {
  Effect: string;
  Action: string | string[];
  Resource: string | string[];
  Condition?: Record<string, unknown>;
}

function synthesize(groot: DiscoveredOutputs['groot']) {
  const outputRoot = path.resolve(__dirname, '../cdk.out');
  fs.mkdirSync(outputRoot, { recursive: true });
  const outdir = fs.mkdtempSync(path.join(outputRoot, 'pipeline-test-'));
  try {
    const app = new cdk.App({ outdir, context: { 'aws:cdk:asset-staging': false, sourceBuildProjectId: 'team-a' } });
    const stack = new DashboardStack(app, 'PipelinePermissions', {
      env: { account: accountId, region },
      accountId,
      region,
      discovered: { accountId, region, groot },
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
      buckets: ['groot-artifacts-913524902871'],
    });
    return Template.fromStack(stack);
  } finally {
    fs.rmSync(outdir, { recursive: true, force: true });
  }
}

function serviceIdentity(template: Template, name: string) {
  const tasks = Object.values(template.findResources('AWS::ECS::TaskDefinition'));
  const task = tasks.find(resource =>
    resource.Properties.ContainerDefinitions.some((container: { Name: string }) => container.Name === name));
  assert.ok(task, `${name} must have an ECS task definition`);
  const container = task.Properties.ContainerDefinitions.find((value: { Name: string }) => value.Name === name);
  const environment = Object.fromEntries(container.Environment.map((entry: { Name: string; Value: string }) => [entry.Name, entry.Value]));
  const roleId = task.Properties.TaskRoleArn['Fn::GetAtt'][0];
  const policies = Object.values(template.findResources('AWS::IAM::Policy'))
    .filter(policy => policy.Properties.Roles?.some((role: { Ref: string }) => role.Ref === roleId));
  const statements: Statement[] = policies.flatMap(policy => policy.Properties.PolicyDocument.Statement);
  assert.ok(statements.length > 0, `${name} policies must be attached to its actual task role`);
  return { environment, statements };
}

function grants(statements: Statement[], action: string) {
  return statements.filter(statement => statement.Effect === 'Allow' &&
    [statement.Action].flat().some(value => value === action || value === '*' || value === `${action.split(':')[0]}:*`));
}

function assertScope(statements: Statement[], action: string, resources: string[]) {
  const matching = grants(statements, action);
  assert.ok(matching.length > 0, `missing ${action} permission`);
  assert.deepEqual([...new Set(matching.flatMap(statement => statement.Resource))].sort(), [...resources].sort(),
    `${action} must be scoped to the configured pipeline`);
}

for (const fixture of [
  {
    label: 'missing PipelineName',
    groot: grootOutputs,
    name: 'groot-sm-finetuning-913524902871',
    arn: 'arn:aws:sagemaker:us-east-1:913524902871:pipeline/groot-sm-finetuning-913524902871',
  },
  {
    label: 'custom PipelineName',
    groot: { ...grootOutputs, PipelineName: 'research-gr00t-custom' },
    name: 'research-gr00t-custom',
    arn: 'arn:aws:sagemaker:us-east-1:913524902871:pipeline/research-gr00t-custom',
  },
]) {
  test(`${fixture.label} aligns synthesized container environments and task-role permissions`, async t => {
    const template = synthesize(fixture.groot);
    for (const name of ['controller', 'web']) {
      const identity = serviceIdentity(template, name);
      await t.test(`${name} receives the resolved name and existing training configuration`, () => {
        assert.equal(identity.environment.SM_PIPELINE_NAME, fixture.name);
        assert.equal(identity.environment.SM_ROLE_ARN, sageMakerRoleArn);
        assert.equal(identity.environment.SM_TRAINING_IMAGE_URI,
          '913524902871.dkr.ecr.us-east-1.amazonaws.com/groot-training:latest');
      });
      await t.test(`${name} can start only the resolved pipeline`, () => {
        assertScope(identity.statements, 'sagemaker:StartPipelineExecution', [fixture.arn]);
      });
      await t.test(`${name} reads evidence only for the resolved pipeline and its executions`, () => {
        for (const action of [
          'sagemaker:DescribePipeline', 'sagemaker:ListPipelineExecutions',
          'sagemaker:DescribePipelineExecution', 'sagemaker:DescribePipelineDefinitionForExecution',
          'sagemaker:ListPipelineExecutionSteps', 'sagemaker:ListPipelineParametersForExecution',
        ]) {
          assertScope(identity.statements, action, [fixture.arn, `${fixture.arn}/execution/*`]);
        }
      });
      await t.test(`${name} passes only the discovered role to SageMaker`, () => {
        assertScope(identity.statements, 'iam:PassRole', [sageMakerRoleArn]);
        for (const statement of grants(identity.statements, 'iam:PassRole')) {
          assert.deepEqual(statement.Condition, { StringEquals: { 'iam:PassedToService': 'sagemaker.amazonaws.com' } });
        }
      });
    }
    await t.test('web cancellation is limited to the resolved pipeline executions', () => {
      assertScope(serviceIdentity(template, 'web').statements, 'sagemaker:StopPipelineExecution', [`${fixture.arn}/execution/*`]);
      assert.equal(grants(serviceIdentity(template, 'controller').statements, 'sagemaker:StopPipelineExecution').length, 0);
    });
    await t.test('gateway has no pipeline start or PassRole permissions', () => {
      const { statements } = serviceIdentity(template, 'gateway');
      assert.equal(grants(statements, 'sagemaker:StartPipelineExecution').length, 0);
      assert.equal(grants(statements, 'iam:PassRole').length, 0);
    });
  });
}

test('absent GR00T stack supplies no pipeline environment or pipeline permissions', () => {
  const template = synthesize(undefined);
  for (const name of ['web', 'controller', 'gateway']) {
    const identity = serviceIdentity(template, name);
    assert.equal(identity.environment.SM_PIPELINE_NAME, undefined);
    for (const action of ['sagemaker:StartPipelineExecution', 'sagemaker:DescribePipeline', 'sagemaker:StopPipelineExecution', 'iam:PassRole']) {
      assert.equal(grants(identity.statements, action).length, 0, `${name} must not grant ${action} without GR00T`);
    }
  }
});
