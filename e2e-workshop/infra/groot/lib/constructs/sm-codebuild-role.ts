import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface SmCodeBuildServiceRoleProps {
  roleName: string;
}

/**
 * SageMaker training/inference 컨테이너 빌드용 공용 CodeBuild 역할 (shared 스택).
 * 모든 사용자 버킷의 codebuild-source/ prefix를 와일드카드로 허용.
 */
export class SmCodeBuildServiceRole extends Construct {
  public readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: SmCodeBuildServiceRoleProps) {
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
          `arn:aws:logs:${stack.region}:${stack.account}:log-group:/aws/codebuild/groot-sm-*`,
        ],
      }),
    );

    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'S3ForBuildSource',
        actions: ['s3:GetObject', 's3:PutObject'],
        resources: ['arn:aws:s3:::*/codebuild-source/*'],
      }),
    );
  }
}
