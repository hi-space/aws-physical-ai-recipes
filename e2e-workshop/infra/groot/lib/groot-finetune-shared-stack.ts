import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { EcrRepo } from './constructs/ecr-repo';
import { CodeBuildInfra } from './constructs/codebuild-infra';
import { TrainingInferenceEcr } from './constructs/sm-ecr-repos';
import { SmCodeBuildServiceRole } from './constructs/sm-codebuild-role';
import { SmContainerBuildProjects } from './constructs/sm-codebuild-projects';
import { NotebookRole } from './constructs/notebook-role';
import { StudioDomain } from './constructs/studio-domain';
import { resolveVpcAndSubnets } from './constructs/vpc-resolver';

export const STUDIO_DOMAIN_ID_PARAMETER = '/groot-finetune/studio-domain-id';
export const SM_TRAINING_REPO_NAME = 'groot-sm-training';
export const SM_INFERENCE_REPO_NAME = 'groot-sm-inference';
export const SM_TRAINING_BUILD_PROJECT = 'groot-sm-training-build';
export const SM_INFERENCE_BUILD_PROJECT = 'groot-sm-inference-build';

export interface GrootFinetuneSharedStackProps extends cdk.StackProps {
  useStableGroot?: boolean;
  grootVersion?: string;
  /** Studio Domain용 VPC. 미지정 시 default VPC 자동 탐지. */
  vpcId?: string;
  subnetIds?: string[];
  /** SageMaker CodeBuild GitHub source. 비워두면 NO_SOURCE. */
  repositoryUrl?: string;
}

/**
 * 단일 통합 shared 스택 (관리자 1회 배포).
 *
 *   - Batch ECR + Batch CodeBuild (auto-trigger build)
 *   - SageMaker training/inference ECR ×2
 *   - SageMaker training/inference CodeBuild ×2 (공용 IAM role)
 *   - Default Notebook role (Studio Domain 기본 실행 역할)
 *   - SageMaker Studio Domain (PublicInternetOnly + IAM)
 *   - SSM Parameter `/groot-finetune/studio-domain-id` (per-user 스택이 lookup)
 */
export class GrootFinetuneSharedStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: GrootFinetuneSharedStackProps = {}) {
    super(scope, id, {
      description: 'GR00T Finetune shared infrastructure (Batch + SageMaker ECR/CodeBuild, Studio Domain)',
      ...props,
    });

    cdk.Tags.of(this).add('Project', 'GrootFinetune');
    cdk.Tags.of(this).add('Scope', 'shared');
    cdk.Tags.of(this).add('Component', 'GrootFinetuneShared');

    // ---------- Batch ECR + CodeBuild (기존 패턴 그대로) ----------
    const batchEcr = new EcrRepo(this, 'BatchEcr');
    const batchCodeBuild = new CodeBuildInfra(this, 'BatchCodeBuild', {
      repository: batchEcr.repository,
      useStableGroot: props.useStableGroot,
      grootVersion: props.grootVersion,
    });
    batchCodeBuild.node.addDependency(batchEcr);

    // ---------- SageMaker ECR ×2 ----------
    const smEcr = new TrainingInferenceEcr(this, 'SmEcr', {
      trainingRepoName: SM_TRAINING_REPO_NAME,
      inferenceRepoName: SM_INFERENCE_REPO_NAME,
    });

    // ---------- SageMaker CodeBuild role + projects (shared) ----------
    const smCodeBuildRole = new SmCodeBuildServiceRole(this, 'SmCodeBuildRole', {
      roleName: 'GR00TCodeBuildRole',
    });

    const smCodeBuild = new SmContainerBuildProjects(this, 'SmCodeBuild', {
      trainingProjectName: SM_TRAINING_BUILD_PROJECT,
      inferenceProjectName: SM_INFERENCE_BUILD_PROJECT,
      role: smCodeBuildRole.role,
      trainingRepository: smEcr.trainingRepository,
      inferenceRepository: smEcr.inferenceRepository,
      repositoryUrl: props.repositoryUrl ?? '',
    });

    // ---------- Studio Domain (with default notebook role) ----------
    const defaultNotebookRole = new NotebookRole(this, 'DefaultNotebookRole', {
      roleName: 'GR00TNotebookRoleDefault',
    });

    const { vpc, subnetIds } = resolveVpcAndSubnets(this, {
      alias: '',
      vpcId: props.vpcId,
      subnetIds: props.subnetIds,
    });

    const studio = new StudioDomain(this, 'StudioDomain', {
      domainName: 'physical-ai-studio',
      vpcId: vpc.vpcId,
      subnetIds,
      defaultExecutionRoleArn: defaultNotebookRole.role.roleArn,
      domainIdParameterName: STUDIO_DOMAIN_ID_PARAMETER,
    });

    // ---------- Outputs ----------
    new cdk.CfnOutput(this, 'BatchEcrName', {
      value: batchEcr.repository.repositoryName,
      description: 'Shared Batch ECR repository name',
      exportName: 'GrootFinetuneShared-BatchEcrName',
    });

    new cdk.CfnOutput(this, 'BatchCodeBuildProjectName', {
      value: batchCodeBuild.project.projectName,
      description: 'Shared Batch CodeBuild project name',
    });

    new cdk.CfnOutput(this, 'SmTrainingEcrName', {
      value: smEcr.trainingRepository.repositoryName,
      description: 'Shared SageMaker training ECR name',
      exportName: 'GrootFinetuneShared-SmTrainingEcrName',
    });

    new cdk.CfnOutput(this, 'SmInferenceEcrName', {
      value: smEcr.inferenceRepository.repositoryName,
      description: 'Shared SageMaker inference ECR name',
      exportName: 'GrootFinetuneShared-SmInferenceEcrName',
    });

    new cdk.CfnOutput(this, 'SmTrainingBuildProjectName', {
      value: smCodeBuild.trainingProject.projectName,
      description: 'Shared SageMaker training CodeBuild project',
    });

    new cdk.CfnOutput(this, 'SmInferenceBuildProjectName', {
      value: smCodeBuild.inferenceProject.projectName,
      description: 'Shared SageMaker inference CodeBuild project',
    });

    new cdk.CfnOutput(this, 'StudioDomainId', {
      value: studio.domain.attrDomainId,
      description: 'Shared SageMaker Studio Domain ID',
      exportName: 'GrootFinetuneShared-StudioDomainId',
    });

    new cdk.CfnOutput(this, 'StudioDomainIdParameter', {
      value: STUDIO_DOMAIN_ID_PARAMETER,
      description: 'SSM parameter name carrying the Studio domain ID',
    });

    new cdk.CfnOutput(this, 'StudioDomainUrl', {
      value: `https://${this.region}.console.aws.amazon.com/sagemaker/home?region=${this.region}#/studio/${studio.domain.attrDomainId}`,
      description: 'SageMaker Studio console URL',
    });

    new cdk.CfnOutput(this, 'DefaultNotebookRoleArn', {
      value: defaultNotebookRole.role.roleArn,
      description: 'Studio Domain 기본 실행 역할 ARN',
      exportName: 'GrootFinetuneShared-DefaultNotebookRoleArn',
    });

    new cdk.CfnOutput(this, 'SharedStackVersion', {
      value: '1',
      description: 'Shared stack schema version (bump to trigger update)',
    });
  }
}
