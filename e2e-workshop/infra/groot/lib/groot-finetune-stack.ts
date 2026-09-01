import * as cdk from 'aws-cdk-lib';
import * as fsx from 'aws-cdk-lib/aws-fsx';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sagemaker from 'aws-cdk-lib/aws-sagemaker';
import { Construct } from 'constructs';

import { EcrRepo } from './constructs/ecr-repo';
import { CodeBuildInfra } from './constructs/codebuild-infra';
import { TrainingEcr } from './constructs/sm-ecr-repos';
import { SmCodeBuildServiceRole } from './constructs/sm-codebuild-role';
import { SmContainerBuildProjects } from './constructs/sm-codebuild-projects';
import { NotebookRole } from './constructs/notebook-role';
import { StudioDomain } from './constructs/studio-domain';
import { ArtifactsBucket } from './constructs/artifacts-bucket';
import { SageMakerExecutionRole } from './constructs/sagemaker-role';

export const STUDIO_DOMAIN_ID_PARAMETER = '/groot-finetune/studio-domain-id';
export const SM_TRAINING_REPO_NAME = 'groot-sm-training';
export const SM_TRAINING_BUILD_PROJECT = 'groot-sm-training-build';

export interface GrootFinetuneStackProps extends cdk.StackProps {
  /** 배포 대상 계정 ID (리소스 이름 접미사, 1인 1계정 전제). */
  accountId: string;
  /** S3 아티팩트 버킷 이름. */
  bucketName: string;
  /** 부모 IsaacLab 스택의 VPC (Studio Domain에 사용). */
  vpcId: string;
  subnetIds: string[];
  availabilityZone?: string;
  /** SageMaker MLflow tracking server 사이즈 (Small/Medium/Large). */
  mlflowSize?: string;
  /**
   * 부모 IsaacLab 스택의 공유 FSx for Lustre ID. 지정되면 아티팩트 버킷과
   * DRA(자동 import/export)를 연결해, SageMaker 학습 잡이 S3로 export한
   * checkpoint가 DCV·HyperPod의 /fsx/groot/... 에 자동으로 나타난다.
   */
  fsxFileSystemId?: string;
  useStableGroot?: boolean;
  grootVersion?: string;
  /** SageMaker CodeBuild GitHub source. 비워두면 NO_SOURCE. */
  repositoryUrl?: string;
}

/**
 * GR00T 파인튜닝 통합 스택 (1계정 1스택).
 *
 * 이전의 GrootFinetuneShared(계정 공용) + GrootFinetuneSagemaker-<userId>(사용자별)
 * 2-스택 구성을 1인 1계정 전제로 단일 스택으로 통합했다.
 *
 *   - GR00T 런타임 ECR + CodeBuild (배포 시 자동 트리거; 모듈 2/3/5 Policy Server 이미지)
 *   - SageMaker training ECR + CodeBuild (trigger_build.py가 소스 zip 업로드 후 빌드)
 *   - SageMaker Studio Domain + UserProfile (실행 역할은 단일 Notebook role)
 *   - S3 아티팩트 버킷 + 부모 FSx DRA (/groot ↔ s3://<bucket>)
 *   - SageMaker 실행 역할, CloudWatch Log Group, MLflow tracking server
 *   - SSM Parameter `/groot-finetune/studio-domain-id` (스크립트/노트북이 lookup)
 */
export class GrootFinetuneStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: GrootFinetuneStackProps) {
    super(scope, id, {
      description: 'GR00T fine-tuning infrastructure (runtime/SageMaker ECR+CodeBuild, Studio, S3, MLflow)',
      ...props,
    });

    const { accountId } = props;
    const named = (base: string) => `${base}-${accountId}`;

    cdk.Tags.of(this).add('Project', 'GrootFinetune');
    cdk.Tags.of(this).add('ManagedBy', 'CDK');

    // ---------- [1] GR00T 런타임 ECR + CodeBuild (auto-trigger build) ----------
    // 모듈 2의 Greengrass 추론과 모듈 3/5의 Policy Server가 공유하는 groot-runtime 이미지.
    const runtimeEcr = new EcrRepo(this, 'BatchEcr');
    const runtimeCodeBuild = new CodeBuildInfra(this, 'BatchCodeBuild', {
      repository: runtimeEcr.repository,
      useStableGroot: props.useStableGroot,
      grootVersion: props.grootVersion,
    });
    runtimeCodeBuild.node.addDependency(runtimeEcr);

    // ---------- [2] SageMaker training ECR + CodeBuild ----------
    const smEcr = new TrainingEcr(this, 'SmEcr', {
      trainingRepoName: SM_TRAINING_REPO_NAME,
    });

    const smCodeBuildRole = new SmCodeBuildServiceRole(this, 'SmCodeBuildRole', {
      roleName: 'GR00TCodeBuildRole',
    });

    const smCodeBuild = new SmContainerBuildProjects(this, 'SmCodeBuild', {
      trainingProjectName: SM_TRAINING_BUILD_PROJECT,
      role: smCodeBuildRole.role,
      trainingRepository: smEcr.trainingRepository,
      repositoryUrl: props.repositoryUrl ?? '',
    });

    // ---------- [3] S3 아티팩트 버킷 ----------
    const artifactsBucket = new ArtifactsBucket(this, 'ArtifactsBucket', {
      bucketName: props.bucketName,
    });

    // ---------- [3.5] 공유 FSx ↔ 아티팩트 버킷 DRA ----------
    // S3에 쓰는 순간 FSx의 /groot 아래에 자동 반영(import)되고, FSx의 /groot 에
    // 쓴 파일도 S3로 자동 export된다. 학습(S3) → 실험(DCV /fsx) → 클러스터
    // (HyperPod /fsx)가 파일 복사 없이 같은 데이터를 본다.
    if (props.fsxFileSystemId) {
      const dra = new fsx.CfnDataRepositoryAssociation(this, 'GrootFsxDra', {
        fileSystemId: props.fsxFileSystemId,
        fileSystemPath: '/groot',
        dataRepositoryPath: `s3://${props.bucketName}`,
        s3: {
          autoImportPolicy: { events: ['NEW', 'CHANGED', 'DELETED'] },
          autoExportPolicy: { events: ['NEW', 'CHANGED', 'DELETED'] },
        },
        tags: [{ key: 'Name', value: named('groot-fsx-dra') }],
      });
      dra.addDependency(artifactsBucket.bucket.node.defaultChild as cdk.CfnResource);

      new cdk.CfnOutput(this, 'FsxGrootPath', {
        value: '/fsx/groot',
        description: 'FSx path mirroring the artifacts bucket (auto import/export)',
      });
    }

    // ---------- [4] IAM ----------
    const smRole = new SageMakerExecutionRole(this, 'SageMakerRole', {
      roleName: named('GR00TSageMakerRole'),
      bucketName: props.bucketName,
    });

    // 단일 Notebook role: Studio Domain 기본 실행 역할과 UserProfile 실행 역할을 겸한다.
    const notebookRole = new NotebookRole(this, 'NotebookRole', {
      roleName: named('GR00TNotebookRole'),
    });

    // ---------- [5] CloudWatch Log Group ----------
    new logs.LogGroup(this, 'SageMakerLogGroup', {
      logGroupName: `/aws/sagemaker/${named('groot-sm')}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ---------- [6] Studio Domain + UserProfile ----------
    const studio = new StudioDomain(this, 'StudioDomain', {
      domainName: 'physical-ai-studio',
      vpcId: props.vpcId,
      subnetIds: props.subnetIds,
      defaultExecutionRoleArn: notebookRole.role.roleArn,
      domainIdParameterName: STUDIO_DOMAIN_ID_PARAMETER,
    });

    const userProfileName = accountId;
    const studioUserProfile = new sagemaker.CfnUserProfile(this, 'StudioUserProfile', {
      domainId: studio.domain.attrDomainId,
      userProfileName,
      userSettings: {
        executionRole: notebookRole.role.roleArn,
      },
    });
    studioUserProfile.addDependency(studio.domain);

    // ---------- [7] MLflow tracking server ----------
    const mlflow = new sagemaker.CfnMlflowTrackingServer(this, 'MlflowTrackingServer', {
      trackingServerName: named('groot-mlflow'),
      artifactStoreUri: `s3://${props.bucketName}/mlflow-artifacts`,
      roleArn: smRole.role.roleArn,
      trackingServerSize: props.mlflowSize ?? 'Small',
      automaticModelRegistration: false,
    });
    mlflow.addDependency(artifactsBucket.bucket.node.defaultChild as cdk.CfnResource);

    // ---------- Outputs ----------
    new cdk.CfnOutput(this, 'RuntimeEcrName', {
      value: runtimeEcr.repository.repositoryName,
      description: 'GR00T runtime ECR repository name',
      exportName: `${this.stackName}-RuntimeEcrName`,
    });
    new cdk.CfnOutput(this, 'RuntimeCodeBuildProjectName', {
      value: runtimeCodeBuild.project.projectName,
      description: 'GR00T runtime CodeBuild project name',
    });
    new cdk.CfnOutput(this, 'SmTrainingEcrName', {
      value: smEcr.trainingRepository.repositoryName,
      description: 'SageMaker training ECR name',
      exportName: `${this.stackName}-SmTrainingEcrName`,
    });
    new cdk.CfnOutput(this, 'SmTrainingBuildProjectName', {
      value: smCodeBuild.trainingProject.projectName,
      description: 'SageMaker training CodeBuild project',
    });
    new cdk.CfnOutput(this, 'StudioDomainId', {
      value: studio.domain.attrDomainId,
      description: 'SageMaker Studio Domain ID',
      exportName: `${this.stackName}-StudioDomainId`,
    });
    new cdk.CfnOutput(this, 'StudioDomainIdParameter', {
      value: STUDIO_DOMAIN_ID_PARAMETER,
      description: 'SSM parameter name carrying the Studio domain ID',
    });
    new cdk.CfnOutput(this, 'StudioDomainUrl', {
      value: `https://${this.region}.console.aws.amazon.com/sagemaker/home?region=${this.region}#/studio/${studio.domain.attrDomainId}`,
      description: 'SageMaker Studio console URL',
    });
    new cdk.CfnOutput(this, 'BucketName', {
      value: artifactsBucket.bucket.bucketName,
      description: 'S3 artifacts bucket',
      exportName: `${this.stackName}-BucketName`,
    });
    new cdk.CfnOutput(this, 'SageMakerRoleArn', {
      value: smRole.role.roleArn,
      description: 'SageMaker execution role ARN',
      exportName: `${this.stackName}-SageMakerRoleArn`,
    });
    new cdk.CfnOutput(this, 'NotebookRoleArn', {
      value: notebookRole.role.roleArn,
      description: 'SageMaker Notebook/Studio execution role ARN',
      exportName: `${this.stackName}-NotebookRoleArn`,
    });
    new cdk.CfnOutput(this, 'StudioUserProfileName', {
      value: userProfileName,
      description: 'SageMaker Studio user profile name',
    });
    new cdk.CfnOutput(this, 'TrainingRepositoryUri', {
      value: smEcr.trainingRepository.repositoryUri,
      description: 'Training ECR URI',
      exportName: `${this.stackName}-TrainingRepositoryUri`,
    });
    new cdk.CfnOutput(this, 'MlflowTrackingServerArn', {
      value: mlflow.attrTrackingServerArn,
      description: 'MLflow tracking server ARN',
      exportName: `${this.stackName}-MlflowTrackingServerArn`,
    });
    new cdk.CfnOutput(this, 'MlflowTrackingServerName', {
      value: named('groot-mlflow'),
      description: 'MLflow tracking server name',
    });
    new cdk.CfnOutput(this, 'UserId', {
      value: accountId,
      description: 'Deployment identifier (AWS account ID)',
    });
  }
}
