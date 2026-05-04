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
}

export class CodeBuildInfra extends Construct {
  public readonly project: codebuild.Project;

  constructor(scope: Construct, id: string, props: CodeBuildInfraProps) {
    super(scope, id);

    const useStable = props.useStableGroot ?? true;

    const sourceAsset = new s3_assets.Asset(this, 'SourceAsset', {
      path: path.join(__dirname, '../../assets'),
      exclude: ['*.pyc', '__pycache__', '.git', '*.egg-info'],
    });

    this.project = new codebuild.Project(this, 'BuildProject', {
      projectName: 'GrootFinetuneContainerBuild',
      description: 'Builds GR00T fine-tuning container and pushes to ECR',
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

    // Auto-trigger build on deploy
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
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['codebuild:StartBuild'],
          resources: [this.project.projectArn],
        }),
      ]),
    });
  }
}
