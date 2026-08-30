import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as fsx from 'aws-cdk-lib/aws-fsx';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sagemaker from 'aws-cdk-lib/aws-sagemaker';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

import { ArtifactsBucket } from './constructs/artifacts-bucket';
import { SageMakerExecutionRole } from './constructs/sagemaker-role';
import { NotebookRole } from './constructs/notebook-role';
import {
  STUDIO_DOMAIN_ID_PARAMETER,
  SM_TRAINING_REPO_NAME,
} from './groot-finetune-shared-stack';

export interface GrootSagemakerStackProps extends cdk.StackProps {
  /** Per-user identifier. 비워두면 단일 사용자(기본 이름). */
  userId?: string;
  /** S3 아티팩트 버킷 이름. */
  bucketName: string;
  /** Studio UserProfile에 사용할 VPC. shared 도메인이 이미 자체 VPC를 가지지만 여기서는 lookup만 위함. */
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
}

/**
 * Per-user SageMaker 파인튜닝 스택.
 *
 *   - S3 아티팩트 버킷
 *   - SageMaker exec role / Notebook role / Lambda role
 *   - CloudWatch Log Group (학습 로그)
 *   - Studio UserProfile (도메인은 shared 스택의 SSM 파라미터에서 lookup)
 *   - MLflow tracking server
 */
export class GrootSagemakerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: GrootSagemakerStackProps) {
    super(scope, id, props);

    const { userId } = props;
    const suffix = userId ? `-${userId}` : '';
    const named = (base: string) => `${base}${suffix}`;

    cdk.Tags.of(this).add('Project', 'GrootFinetune');
    cdk.Tags.of(this).add('Scope', 'per-user');
    if (userId) cdk.Tags.of(this).add('UserId', userId);

    // ---------- Shared 리소스 import ----------
    const trainingRepository = ecr.Repository.fromRepositoryName(
      this,
      'SharedTrainingRepo',
      SM_TRAINING_REPO_NAME,
    );
    const studioDomainId = ssm.StringParameter.valueForStringParameter(
      this,
      STUDIO_DOMAIN_ID_PARAMETER,
    );

    // ---------- [1] S3 ----------
    const artifactsBucket = new ArtifactsBucket(this, 'ArtifactsBucket', {
      bucketName: props.bucketName,
    });

    // ---------- [1.5] 공유 FSx ↔ 아티팩트 버킷 DRA ----------
    // S3에 쓰는 순간 FSx의 /groot 아래에 자동 반영(import)되고, FSx의 /groot 에
    // 쓴 파일도 S3로 자동 export된다. 학습(S3) → 실험(DCV /fsx) → 클러스터
    // (HyperPod /fsx)가 파일 복사 없이 같은 데이터를 본다.
    if (props.fsxFileSystemId) {
      // 부모 FSx는 사용자별 isaaclab 스택 소유이므로 경로에 userId 접미사가 필요 없다.
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

    // ---------- [2] IAM ----------
    const smRole = new SageMakerExecutionRole(this, 'SageMakerRole', {
      roleName: named('GR00TSageMakerRole'),
      bucketName: props.bucketName,
    });

    const notebookRole = new NotebookRole(this, 'NotebookRole', {
      roleName: named('GR00TNotebookRole'),
    });

    // ---------- [3] CloudWatch Log Group ----------
    new logs.LogGroup(this, 'SageMakerLogGroup', {
      logGroupName: `/aws/sagemaker/${named('groot-sm')}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ---------- [4] Studio UserProfile (shared domain 사용) ----------
    const userProfileName = userId ?? 'default';
    const studioUserProfile = new sagemaker.CfnUserProfile(this, 'StudioUserProfile', {
      domainId: studioDomainId,
      userProfileName,
      userSettings: {
        executionRole: notebookRole.role.roleArn,
      },
    });

    // ---------- [5] MLflow tracking server ----------
    const mlflow = new sagemaker.CfnMlflowTrackingServer(this, 'MlflowTrackingServer', {
      trackingServerName: named('groot-mlflow'),
      artifactStoreUri: `s3://${props.bucketName}/mlflow-artifacts`,
      roleArn: smRole.role.roleArn,
      trackingServerSize: props.mlflowSize ?? 'Small',
      automaticModelRegistration: false,
    });
    mlflow.addDependency(artifactsBucket.bucket.node.defaultChild as cdk.CfnResource);

    // ---------- Outputs ----------
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
      description: 'SageMaker Notebook role ARN',
      exportName: `${this.stackName}-NotebookRoleArn`,
    });
    new cdk.CfnOutput(this, 'StudioUserProfileName', {
      value: userProfileName,
      description: 'SageMaker Studio user profile name',
    });
    new cdk.CfnOutput(this, 'TrainingRepositoryUri', {
      value: trainingRepository.repositoryUri,
      description: 'Shared training ECR URI',
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
    if (userId) {
      new cdk.CfnOutput(this, 'UserId', {
        value: userId,
        description: 'Per-user identifier',
      });
    }
  }
}
