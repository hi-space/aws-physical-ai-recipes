import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface NotebookRoleProps {
  roleName: string;
}

/**
 * SageMaker Studio / Notebook 사용자 역할.
 *   - 이 repo의 스크립트(deploy_stack, run_training, trigger_build, deploy_endpoint, ...)를
 *     노트북에서 실행할 때 사용.
 *   - SageMaker / S3 FullAccess + CodeBuild, ECR, CloudFormation, IAM PassRole, SSM, Logs, MLflow.
 */
export class NotebookRole extends Construct {
  public readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: NotebookRoleProps) {
    super(scope, id);

    const stack = cdk.Stack.of(this);

    this.role = new iam.Role(this, 'Role', {
      roleName: props.roleName,
      assumedBy: new iam.ServicePrincipal('sagemaker.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSageMakerFullAccess'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonS3FullAccess'),
      ],
    });

    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'StudioSpaceStartSession',
        actions: ['sagemaker:StartSession'],
        resources: [
          `arn:aws:sagemaker:${stack.region}:${stack.account}:space/*`,
          `arn:aws:sagemaker:${stack.region}:${stack.account}:app/*`,
        ],
      }),
    );

    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'CodeBuildManage',
        actions: [
          'codebuild:StartBuild',
          'codebuild:StopBuild',
          'codebuild:BatchGetBuilds',
          'codebuild:BatchGetProjects',
          'codebuild:ListBuilds',
          'codebuild:ListBuildsForProject',
          'codebuild:ListProjects',
        ],
        resources: ['*'],
      }),
    );

    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ECRFull',
        actions: [
          'ecr:GetAuthorizationToken',
          'ecr:BatchCheckLayerAvailability',
          'ecr:GetDownloadUrlForLayer',
          'ecr:BatchGetImage',
          'ecr:InitiateLayerUpload',
          'ecr:UploadLayerPart',
          'ecr:CompleteLayerUpload',
          'ecr:PutImage',
          'ecr:DescribeRepositories',
          'ecr:DescribeImages',
          'ecr:ListImages',
          'ecr:CreateRepository',
        ],
        resources: ['*'],
      }),
    );

    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'CloudFormationStack',
        actions: [
          'cloudformation:CreateStack',
          'cloudformation:UpdateStack',
          'cloudformation:DeleteStack',
          'cloudformation:DescribeStacks',
          'cloudformation:DescribeStackEvents',
          'cloudformation:DescribeStackResources',
          'cloudformation:GetTemplate',
          'cloudformation:ListStacks',
          'cloudformation:ValidateTemplate',
        ],
        resources: ['*'],
      }),
    );

    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'PassRoleForServices',
        actions: ['iam:PassRole'],
        resources: ['*'],
        conditions: {
          StringEquals: {
            'iam:PassedToService': [
              'sagemaker.amazonaws.com',
              'codebuild.amazonaws.com',
            ],
          },
        },
      }),
    );

    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'IAMRead',
        actions: [
          'iam:GetRole',
          'iam:ListRoles',
          'iam:ListAttachedRolePolicies',
          'iam:ListRolePolicies',
        ],
        resources: ['*'],
      }),
    );

    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'SSMParams',
        actions: [
          'ssm:GetParameter',
          'ssm:GetParameters',
          'ssm:PutParameter',
          'ssm:DescribeParameters',
        ],
        resources: [
          `arn:aws:ssm:${stack.region}:${stack.account}:parameter/groot/*`,
          `arn:aws:ssm:${stack.region}:${stack.account}:parameter/cdk-bootstrap/*`,
        ],
      }),
    );

    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'CloudWatchLogsRead',
        actions: [
          'logs:DescribeLogGroups',
          'logs:DescribeLogStreams',
          'logs:GetLogEvents',
          'logs:FilterLogEvents',
        ],
        resources: ['*'],
      }),
    );

    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'MlflowFull',
        actions: [
          'sagemaker-mlflow:*',
          'sagemaker:CreateMlflowTrackingServer',
          'sagemaker:DeleteMlflowTrackingServer',
          'sagemaker:DescribeMlflowTrackingServer',
          'sagemaker:ListMlflowTrackingServers',
          'sagemaker:StartMlflowTrackingServer',
          'sagemaker:StopMlflowTrackingServer',
          'sagemaker:CreatePresignedMlflowTrackingServerUrl',
        ],
        resources: ['*'],
      }),
    );

    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'CDKBootstrapAssumeRole',
        actions: ['sts:AssumeRole'],
        resources: [`arn:aws:iam::${stack.account}:role/cdk-*`],
      }),
    );

    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'CDKSTSIdentity',
        actions: ['sts:GetCallerIdentity'],
        resources: ['*'],
      }),
    );

    cdk.Tags.of(this.role).add('Purpose', 'SageMakerNotebook');
  }
}
