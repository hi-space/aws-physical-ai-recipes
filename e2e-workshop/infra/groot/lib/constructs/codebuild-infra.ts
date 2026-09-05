import * as cdk from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3_assets from 'aws-cdk-lib/aws-s3-assets';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as path from 'path';
import { Construct } from 'constructs';

export interface CodeBuildInfraProps {
  repository: ecr.IRepository;
  useStableGroot?: boolean;
  grootVersion?: string;
}

export class CodeBuildInfra extends Construct {
  public readonly project: codebuild.Project;

  constructor(scope: Construct, id: string, props: CodeBuildInfraProps) {
    super(scope, id);

    const useStable = props.useStableGroot ?? true;
    const grootVersion = props.grootVersion ?? 'n1.6';

    const sourceAsset = new s3_assets.Asset(this, 'SourceAsset', {
      path: path.join(__dirname, '../../assets'),
      exclude: ['*.pyc', '__pycache__', '.git', '*.egg-info'],
    });

    this.project = new codebuild.Project(this, 'BuildProject', {
      projectName: 'groot-runtime-build',
      description: 'Builds the GR00T runtime container (inference + fine-tuning) and pushes to ECR',
      source: codebuild.Source.s3({
        bucket: sourceAsset.bucket,
        path: sourceAsset.s3ObjectKey,
      }),
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.X2_LARGE,
        privileged: true,
      },
      environmentVariables: {
        ECR_REPOSITORY_NAME: { value: props.repository.repositoryName },
        USE_STABLE: { value: useStable ? 'true' : 'false' },
        GROOT_VERSION: { value: grootVersion },
        IMAGE_TAG: { value: 'latest' },
      },
      buildSpec: codebuild.BuildSpec.fromSourceFilename('buildspec.yml'),
      timeout: cdk.Duration.hours(2),
    });

    props.repository.grantPullPush(this.project.role!);
    sourceAsset.grantRead(this.project.role!);

    this.project.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ecr:GetAuthorizationToken'],
      resources: ['*'],
    }));

    // Auto-trigger build on deploy.
    //
    // 커스텀 리소스 Lambda의 권한은 별도 AWS::IAM::Policy가 아니라 Role 자체의
    // inlinePolicies로 넣는다. `policy` prop을 쓰면 Policy 리소스가 붙는 즉시 Lambda가
    // 호출되어 IAM 전파가 끝나기 전에 AccessDenied가 날 수 있다. Role → Lambda 함수 생성
    // → 호출 순서로 두면 함수 생성 시간이 전파 시간을 덮는다.
    //
    // AwsCustomResource 는 스택당 Lambda 하나를 공유(singleton)하므로, 이 스택에 다른
    // AwsCustomResource 를 추가할 때는 필요한 권한을 이 Role 의 inlinePolicies 에 함께 넣는다.
    const triggerRole = new iam.Role(this, 'TriggerBuildRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
      inlinePolicies: {
        StartBuild: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['codebuild:StartBuild'],
              resources: [this.project.projectArn],
            }),
          ],
        }),
      },
    });

    new cr.AwsCustomResource(this, 'TriggerBuild', {
      onCreate: {
        service: 'CodeBuild',
        action: 'startBuild',
        parameters: { projectName: this.project.projectName },
        physicalResourceId: cr.PhysicalResourceId.of(`${this.project.projectName}-${sourceAsset.assetHash}`),
      },
      onUpdate: {
        service: 'CodeBuild',
        action: 'startBuild',
        parameters: { projectName: this.project.projectName },
        physicalResourceId: cr.PhysicalResourceId.of(`${this.project.projectName}-${sourceAsset.assetHash}`),
      },
      role: triggerRole,
      installLatestAwsSdk: false,
    });
  }
}
