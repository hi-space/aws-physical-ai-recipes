import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface SageMakerExecutionRoleProps {
  roleName: string;
  bucketName: string;
}

/**
 * SageMaker 학습/추론 잡 실행 역할.
 *   - AmazonSageMakerFullAccess + 버킷별 S3, SSM(/groot/*), ECR pull, MLflow, Lambda invoke.
 */
export class SageMakerExecutionRole extends Construct {
  public readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: SageMakerExecutionRoleProps) {
    super(scope, id);

    const stack = cdk.Stack.of(this);

    this.role = new iam.Role(this, 'Role', {
      roleName: props.roleName,
      assumedBy: new iam.ServicePrincipal('sagemaker.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSageMakerFullAccess'),
      ],
    });

    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'S3BucketAccess',
        actions: [
          's3:GetObject',
          's3:PutObject',
          's3:DeleteObject',
          's3:ListBucket',
          's3:GetBucketLocation',
        ],
        resources: [
          `arn:aws:s3:::${props.bucketName}`,
          `arn:aws:s3:::${props.bucketName}/*`,
        ],
      }),
    );

    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'SSMParamRead',
        actions: ['ssm:GetParameter', 'ssm:GetParameters'],
        resources: [
          `arn:aws:ssm:${stack.region}:${stack.account}:parameter/groot/*`,
        ],
      }),
    );

    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ECRPull',
        actions: [
          'ecr:GetDownloadUrlForLayer',
          'ecr:BatchGetImage',
          'ecr:GetAuthorizationToken',
        ],
        resources: ['*'],
      }),
    );

    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'MlflowTracking',
        actions: ['sagemaker-mlflow:*', 'sagemaker:DescribeMlflowTrackingServer'],
        resources: ['*'],
      }),
    );
  }
}
