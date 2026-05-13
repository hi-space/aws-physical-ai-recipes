import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface CodeBuildServiceRoleProps {
  roleName: string;
  bucketName: string;
}

/**
 * CodeBuild 서비스 역할 — ECR push, CloudWatch Logs, S3(소스 zip).
 */
export class CodeBuildServiceRole extends Construct {
  public readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: CodeBuildServiceRoleProps) {
    super(scope, id);

    const stack = cdk.Stack.of(this);

    this.role = new iam.Role(this, 'Role', {
      roleName: props.roleName,
      assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
    });

    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ECRPush',
        actions: [
          'ecr:GetAuthorizationToken',
          'ecr:BatchCheckLayerAvailability',
          'ecr:GetDownloadUrlForLayer',
          'ecr:BatchGetImage',
          'ecr:InitiateLayerUpload',
          'ecr:UploadLayerPart',
          'ecr:CompleteLayerUpload',
          'ecr:PutImage',
        ],
        resources: ['*'],
      }),
    );

    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'CloudWatchLogs',
        actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [
          `arn:aws:logs:${stack.region}:${stack.account}:log-group:/aws/codebuild/groot-n16-*`,
        ],
      }),
    );

    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'S3ForBuildSource',
        actions: ['s3:GetObject', 's3:PutObject'],
        resources: [`arn:aws:s3:::${props.bucketName}/codebuild-source/*`],
      }),
    );
  }
}
