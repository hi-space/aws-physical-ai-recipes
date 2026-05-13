import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sagemaker from 'aws-cdk-lib/aws-sagemaker';
import { Construct } from 'constructs';

import { ArtifactsBucket } from './constructs/artifacts-bucket';
import { SageMakerExecutionRole } from './constructs/sagemaker-role';
import { CodeBuildServiceRole } from './constructs/codebuild-role';
import { NotebookRole } from './constructs/notebook-role';
import { TrainingInferenceEcr } from './constructs/ecr-repos';
import { ContainerBuildProjects } from './constructs/codebuild-projects';
import { DeployEndpointLambda } from './constructs/deploy-endpoint-lambda';
import { resolveVpcAndSubnets } from './vpc-resolver';

export interface GrootSmStackProps extends cdk.StackProps {
  alias: string;
  bucketName: string;
  repositoryUrl: string;
  mlflowSize: string;
  roleName: string;
  codeBuildRoleName: string;
  notebookRoleName: string;
  vpcId?: string;
  subnetIds?: string[];
  availabilityZone?: string;
}

export class GrootSmStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: GrootSmStackProps) {
    super(scope, id, props);

    const alias = props.alias;
    const suffix = alias ? `-${alias}` : '';
    const named = (base: string) => `${base}${suffix}`;

    // -------------------------------------------------------------------------
    // VPC / Subnets — Studio 도메인은 PublicInternetOnly여도 필수
    // -------------------------------------------------------------------------
    const { vpc, subnetIds } = resolveVpcAndSubnets(this, {
      alias,
      vpcId: props.vpcId,
      subnetIds: props.subnetIds,
      availabilityZone: props.availabilityZone,
    });

    // -------------------------------------------------------------------------
    // [1] S3 Bucket
    // -------------------------------------------------------------------------
    const artifactsBucket = new ArtifactsBucket(this, 'ArtifactsBucket', {
      bucketName: props.bucketName,
    });

    // -------------------------------------------------------------------------
    // [2] IAM: SageMaker / CodeBuild / Notebook 역할
    // -------------------------------------------------------------------------
    const smRole = new SageMakerExecutionRole(this, 'SageMakerRole', {
      roleName: named(props.roleName),
      bucketName: props.bucketName,
    });

    const codeBuildRole = new CodeBuildServiceRole(this, 'CodeBuildRole', {
      roleName: named(props.codeBuildRoleName),
      bucketName: props.bucketName,
    });

    const notebookRole = new NotebookRole(this, 'NotebookRole', {
      roleName: named(props.notebookRoleName),
    });

    // -------------------------------------------------------------------------
    // [3] ECR: training / inference
    // -------------------------------------------------------------------------
    const ecr = new TrainingInferenceEcr(this, 'Ecr', {
      trainingRepoName: named('groot-n16-training'),
      inferenceRepoName: named('groot-n16-inference'),
    });

    // -------------------------------------------------------------------------
    // [4] CodeBuild projects (training / inference)
    // -------------------------------------------------------------------------
    const codeBuild = new ContainerBuildProjects(this, 'CodeBuild', {
      alias,
      role: codeBuildRole.role,
      trainingRepository: ecr.trainingRepository,
      inferenceRepository: ecr.inferenceRepository,
      bucketName: props.bucketName,
      repositoryUrl: props.repositoryUrl,
    });

    // -------------------------------------------------------------------------
    // SSM 파라미터(/groot/hf-token, /groot/wandb-key)는 CDK 가 만들지 않습니다.
    //   - 사용자가 `aws ssm put-parameter` 로 직접 등록 (README Step 1 (선택) 참고)
    //   - 이미 누군가 만들어 놓았으면 그 값을 그대로 공유 사용
    // -------------------------------------------------------------------------

    // -------------------------------------------------------------------------
    // [5] CloudWatch Log Group: SageMaker 학습 로그
    // -------------------------------------------------------------------------
    new logs.LogGroup(this, 'SageMakerLogGroup', {
      logGroupName: `/aws/sagemaker/${named('groot-n16')}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // -------------------------------------------------------------------------
    // [6] SageMaker Studio Domain (PublicInternetOnly + IAM)
    // -------------------------------------------------------------------------
    const studioDomain = new sagemaker.CfnDomain(this, 'StudioDomain', {
      domainName: named('groot-n16-studio'),
      authMode: 'IAM',
      appNetworkAccessType: 'PublicInternetOnly',
      vpcId: vpc.vpcId,
      subnetIds,
      defaultUserSettings: {
        executionRole: notebookRole.role.roleArn,
        studioWebPortal: 'ENABLED',
        defaultLandingUri: 'studio::',
      },
      tags: [{ key: 'Project', value: 'GR00T-N1.6' }],
    });

    const studioUserProfileName = alias ? `groot-${alias}` : 'groot-default';
    const studioUserProfile = new sagemaker.CfnUserProfile(this, 'StudioUserProfile', {
      domainId: studioDomain.attrDomainId,
      userProfileName: studioUserProfileName,
      userSettings: {
        executionRole: notebookRole.role.roleArn,
      },
    });
    studioUserProfile.addDependency(studioDomain);

    // -------------------------------------------------------------------------
    // [7] SageMaker managed MLflow tracking server
    // -------------------------------------------------------------------------
    const mlflow = new sagemaker.CfnMlflowTrackingServer(this, 'MlflowTrackingServer', {
      trackingServerName: named('groot-mlflow'),
      artifactStoreUri: `s3://${props.bucketName}/mlflow-artifacts`,
      roleArn: smRole.role.roleArn,
      trackingServerSize: props.mlflowSize,
      automaticModelRegistration: false,
    });
    mlflow.addDependency(artifactsBucket.bucket.node.defaultChild as cdk.CfnResource);

    // -------------------------------------------------------------------------
    // [8] Pipeline LambdaStep용 endpoint 배포 Lambda
    // -------------------------------------------------------------------------
    const deployLambda = new DeployEndpointLambda(this, 'DeployEndpointLambda', {
      functionName: named('groot-deploy-endpoint'),
      roleName: named('GR00TDeployEndpointLambdaRole'),
      sageMakerRoleArn: smRole.role.roleArn,
    });

    // -------------------------------------------------------------------------
    // Outputs
    // -------------------------------------------------------------------------
    new cdk.CfnOutput(this, 'BucketName', {
      value: artifactsBucket.bucket.bucketName,
      description: 'S3 버킷 이름',
      exportName: `${this.stackName}-BucketName`,
    });
    new cdk.CfnOutput(this, 'SageMakerRoleArn', {
      value: smRole.role.roleArn,
      description: 'SageMaker 실행 역할 ARN',
      exportName: `${this.stackName}-SageMakerRoleArn`,
    });
    new cdk.CfnOutput(this, 'NotebookRoleArn', {
      value: notebookRole.role.roleArn,
      description: 'SageMaker Notebook 역할 ARN',
      exportName: `${this.stackName}-NotebookRoleArn`,
    });
    new cdk.CfnOutput(this, 'NotebookRoleName', {
      value: notebookRole.role.roleName,
      description: 'SageMaker Notebook 역할 이름',
    });
    new cdk.CfnOutput(this, 'TrainingRepositoryUri', {
      value: ecr.trainingRepository.repositoryUri,
      description: '학습 컨테이너 ECR URI',
      exportName: `${this.stackName}-TrainingRepositoryUri`,
    });
    new cdk.CfnOutput(this, 'InferenceRepositoryUri', {
      value: ecr.inferenceRepository.repositoryUri,
      description: '추론 컨테이너 ECR URI',
      exportName: `${this.stackName}-InferenceRepositoryUri`,
    });
    new cdk.CfnOutput(this, 'TrainingRepositoryName', {
      value: ecr.trainingRepository.repositoryName,
      description: '학습 ECR 리포지토리 이름',
    });
    new cdk.CfnOutput(this, 'InferenceRepositoryName', {
      value: ecr.inferenceRepository.repositoryName,
      description: '추론 ECR 리포지토리 이름',
    });
    new cdk.CfnOutput(this, 'TrainingBuildProjectName', {
      value: codeBuild.trainingProject.projectName,
      description: '학습 컨테이너 CodeBuild 프로젝트 이름',
    });
    new cdk.CfnOutput(this, 'InferenceBuildProjectName', {
      value: codeBuild.inferenceProject.projectName,
      description: '추론 컨테이너 CodeBuild 프로젝트 이름',
    });
    new cdk.CfnOutput(this, 'Alias', {
      value: alias,
      description: '리소스 이름 postfix (alias)',
    });
    new cdk.CfnOutput(this, 'StudioDomainId', {
      value: studioDomain.attrDomainId,
      description: 'SageMaker Studio 도메인 ID',
      exportName: `${this.stackName}-StudioDomainId`,
    });
    new cdk.CfnOutput(this, 'StudioDomainUrl', {
      value: `https://${this.region}.console.aws.amazon.com/sagemaker/home?region=${this.region}#/studio/${studioDomain.attrDomainId}`,
      description: 'SageMaker Studio 콘솔 URL',
    });
    new cdk.CfnOutput(this, 'StudioUserProfileName', {
      value: studioUserProfileName,
      description: '기본 Studio 사용자 프로필 이름',
    });
    new cdk.CfnOutput(this, 'MlflowTrackingServerArn', {
      value: mlflow.attrTrackingServerArn,
      description: 'SageMaker managed MLflow tracking server ARN',
      exportName: `${this.stackName}-MlflowTrackingServerArn`,
    });
    new cdk.CfnOutput(this, 'MlflowTrackingServerName', {
      value: named('groot-mlflow'),
      description: 'MLflow tracking server 이름',
    });
    new cdk.CfnOutput(this, 'DeployEndpointLambdaArn', {
      value: deployLambda.function.functionArn,
      description: 'Pipeline LambdaStep endpoint 배포 Lambda ARN',
      exportName: `${this.stackName}-DeployEndpointLambdaArn`,
    });
    new cdk.CfnOutput(this, 'DeployEndpointLambdaName', {
      value: deployLambda.function.functionName,
      description: 'endpoint 배포 Lambda 함수 이름',
    });
  }
}
