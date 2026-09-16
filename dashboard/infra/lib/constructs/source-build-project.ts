import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';
import { Construct } from 'constructs';

export interface SourceBuildProjectProps {
  repositoryRoot: string;
  projectId?: string;
  projectName?: string;
  /** Explicit local source directory; omitted uses the tiny no-base-pull smoke snapshot. */
  sourceDirectory?: string;
}
/** Parent-owned integration construct. Creates no running build, GPU or Lambda. */
export class SourceBuildProject extends Construct {
  readonly sourceAsset: s3assets.Asset;
  readonly repository: ecr.Repository;
  readonly build: codebuild.CfnProject;
  readonly role: iam.Role;
  readonly logGroup: logs.LogGroup;
  readonly target: {
    id: string; projectId: string; codeBuildProjectName: string; sourceType: 'S3';
    snapshotLocation: { bucket: string; key: string }; serviceRoleArn: string; builderImage: string;
    outputRepositoryName: string; dockerfile: string; context: string; timeoutMinutes: number;
    queuedTimeoutMinutes: number; computeType: 'BUILD_GENERAL1_SMALL';
  };
  constructor(scope: Construct, id: string, props: SourceBuildProjectProps) {
    super(scope, id);
    const stack = cdk.Stack.of(this), projectId = props.projectId ?? 'workshop';
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(projectId) || stack.region !== 'us-east-1') throw new Error('Source build project requires a valid project ID and us-east-1');
    const name = props.projectName ?? `physical-ai-source-${projectId}-${stack.account}`;
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{1,99}$/.test(name)) throw new Error('Invalid registered source build job name');
    const projectArn = stack.formatArn({ service: 'codebuild', resource: 'project', resourceName: name });
    this.sourceAsset = new s3assets.Asset(this, 'SourceSnapshot', {
      path: props.sourceDirectory ?? path.join(props.repositoryRoot, 'dashboard/infra/source-build-example'),
      exclude: ['.git', 'node_modules', '.venv', '__pycache__', '*.pyc', '.env*', '**/.env*', '.aws', '**/.aws', '.ssh', '**/.ssh',
        '.next', 'dist', 'cdk.out', '*.tsbuildinfo', 'test-results', 'playwright-report'],
    });
    const outputRepositoryName = `physical-ai/projects/${projectId}/source-images`;
    this.repository = new ecr.Repository(this, 'Output', {
      repositoryName: outputRepositoryName, imageTagMutability: ecr.TagMutability.IMMUTABLE,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    this.logGroup = new logs.LogGroup(this, 'Logs', {
      logGroupName: `/aws/codebuild/${name}`, retention: logs.RetentionDays.ONE_MONTH, removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    this.role = new iam.Role(this, 'BuilderRole', { assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com', {
      conditions: { StringEquals: { 'aws:SourceAccount': stack.account }, ArnEquals: { 'aws:SourceArn': projectArn } },
    }) });
    this.grantSourceRead(this.role);
    this.role.addToPolicy(new iam.PolicyStatement({ actions: ['s3:GetBucketLocation', 's3:GetBucketAcl'], resources: [this.sourceAsset.bucket.bucketArn] }));
    this.repository.grantPullPush(this.role);
    this.logGroup.grantWrite(this.role);
    const buildspec = JSON.parse(fs.readFileSync(path.join(props.repositoryRoot, 'dashboard/web/src/server/services/source-buildspec.json'), 'utf8')).text as string;
    // L1 avoids Source.s3's whole-bucket grants. The role reads only this ZIP/version.
    this.build = new codebuild.CfnProject(this, 'Project', {
      name, description: `Project-scoped source image builder for ${projectId}`,
      serviceRole: this.role.roleArn, source: { type: 'S3', location: `${this.sourceAsset.s3BucketName}/${this.sourceAsset.s3ObjectKey}`, buildSpec: buildspec },
      artifacts: { type: 'NO_ARTIFACTS' }, cache: { type: 'NO_CACHE' },
      environment: { type: 'LINUX_CONTAINER', computeType: 'BUILD_GENERAL1_SMALL', image: 'aws/codebuild/standard:7.0',
        imagePullCredentialsType: 'CODEBUILD', privilegedMode: true, environmentVariables: [] },
      timeoutInMinutes: 20, queuedTimeoutInMinutes: 5, concurrentBuildLimit: 1, autoRetryLimit: 0,
      logsConfig: { cloudWatchLogs: { status: 'ENABLED', groupName: this.logGroup.logGroupName }, s3Logs: { status: 'DISABLED' } },
      tags: [{ key: 'pai:project', value: projectId }, { key: 'pai:purpose', value: 'source-image-build' }],
    });
    this.target = { id: projectId, projectId, codeBuildProjectName: name, sourceType: 'S3',
      snapshotLocation: { bucket: this.sourceAsset.s3BucketName, key: this.sourceAsset.s3ObjectKey },
      serviceRoleArn: this.role.roleArn, builderImage: 'aws/codebuild/standard:7.0',
      outputRepositoryName, dockerfile: 'Dockerfile', context: '.',
      timeoutMinutes: 20, queuedTimeoutMinutes: 5, computeType: 'BUILD_GENERAL1_SMALL' };
  }
  grantSourceRead(grantee: iam.IGrantable) {
    return iam.Grant.addToPrincipal({ grantee, actions: ['s3:GetObject', 's3:GetObjectVersion'],
      resourceArns: [this.sourceAsset.bucket.arnForObjects(this.sourceAsset.s3ObjectKey)] });
  }
  /** Parent invokes for the web/worker roles and adds the existing DDB ledger grants. */
  grantControlPlane(grantee: iam.IGrantable) {
    const stack = cdk.Stack.of(this);
    this.grantSourceRead(grantee);
    iam.Grant.addToPrincipal({ grantee, actions: ['codebuild:BatchGetProjects', 'codebuild:ListBuildsForProject', 'codebuild:StartBuild', 'codebuild:BatchGetBuilds', 'codebuild:StopBuild'],
      resourceArns: [stack.formatArn({ service: 'codebuild', resource: 'project', resourceName: this.target.codeBuildProjectName })] });
    iam.Grant.addToPrincipal({ grantee, actions: ['ecr:DescribeRepositories', 'ecr:DescribeImages', 'ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer'],
      resourceArns: [this.repository.repositoryArn] });
    iam.Grant.addToPrincipal({ grantee, actions: ['ecr:GetAuthorizationToken'], resourceArns: ['*'] });
    iam.Grant.addToPrincipal({ grantee, actions: ['logs:GetLogEvents'], resourceArns: [this.logGroup.logGroupArn] });
  }
}
