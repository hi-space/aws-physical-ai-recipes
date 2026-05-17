import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sagemaker from 'aws-cdk-lib/aws-sagemaker';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

import { ArtifactsBucket } from './constructs/artifacts-bucket';
import { SageMakerExecutionRole } from './constructs/sagemaker-role';
import { NotebookRole } from './constructs/notebook-role';
import { DeployEndpointLambda } from './constructs/deploy-endpoint-lambda';
import {
  STUDIO_DOMAIN_ID_PARAMETER,
  SM_TRAINING_REPO_NAME,
  SM_INFERENCE_REPO_NAME,
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
}

/**
 * Per-user SageMaker 파인튜닝 스택.
 *
 *   - S3 아티팩트 버킷
 *   - SageMaker exec role / Notebook role / Lambda role
 *   - CloudWatch Log Group (학습 로그)
 *   - Studio UserProfile (도메인은 shared 스택의 SSM 파라미터에서 lookup)
 *   - MLflow tracking server
 *   - Deploy endpoint Lambda
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
    const inferenceRepository = ecr.Repository.fromRepositoryName(
      this,
      'SharedInferenceRepo',
      SM_INFERENCE_REPO_NAME,
    );
    const studioDomainId = ssm.StringParameter.valueForStringParameter(
      this,
      STUDIO_DOMAIN_ID_PARAMETER,
    );

    // ---------- [1] S3 ----------
    const artifactsBucket = new ArtifactsBucket(this, 'ArtifactsBucket', {
      bucketName: props.bucketName,
    });

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

    // ---------- [6] Deploy endpoint Lambda ----------
    const deployLambda = new DeployEndpointLambda(this, 'DeployEndpointLambda', {
      functionName: named('groot-deploy-endpoint'),
      roleName: named('GR00TDeployEndpointLambdaRole'),
      sageMakerRoleArn: smRole.role.roleArn,
    });

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
    new cdk.CfnOutput(this, 'InferenceRepositoryUri', {
      value: inferenceRepository.repositoryUri,
      description: 'Shared inference ECR URI',
      exportName: `${this.stackName}-InferenceRepositoryUri`,
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
    new cdk.CfnOutput(this, 'DeployEndpointLambdaArn', {
      value: deployLambda.function.functionArn,
      description: 'Deploy endpoint Lambda ARN',
      exportName: `${this.stackName}-DeployEndpointLambdaArn`,
    });
    new cdk.CfnOutput(this, 'DeployEndpointLambdaName', {
      value: deployLambda.function.functionName,
      description: 'Deploy endpoint Lambda name',
    });
    if (userId) {
      new cdk.CfnOutput(this, 'UserId', {
        value: userId,
        description: 'Per-user identifier',
      });
    }
  }
}
