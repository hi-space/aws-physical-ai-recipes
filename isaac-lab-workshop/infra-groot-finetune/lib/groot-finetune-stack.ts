import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { SharedResourceImporter } from './constructs/shared-resource-importer';
import { EcrRepo } from './constructs/ecr-repo';
import { CodeBuildInfra } from './constructs/codebuild-infra';
import { BatchComputeEnv } from './constructs/batch-compute-env';
import { BatchJobDefinition } from './constructs/batch-job-definition';

export interface GrootFinetuneStackProps extends cdk.StackProps {
  vpcId: string;
  efsFileSystemId: string;
  efsSecurityGroupId: string;
  privateSubnetId: string;
  availabilityZone: string;
  userId?: string;
  useStableGroot?: boolean;
}

export class GrootFinetuneStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: GrootFinetuneStackProps) {
    super(scope, id, props);

    const userId = props.userId ?? '';
    const userSuffix = userId ? `-${userId}` : '';
    const namePrefix = `GrootFinetune${userSuffix}`;

    if (userId) {
      cdk.Tags.of(this).add('UserId', userId);
    }

    // [1] Import shared resources from infra-multiuser-groot
    const shared = new SharedResourceImporter(this, 'SharedResources', {
      vpcId: props.vpcId,
      efsFileSystemId: props.efsFileSystemId,
      efsSecurityGroupId: props.efsSecurityGroupId,
      privateSubnetId: props.privateSubnetId,
      availabilityZone: props.availabilityZone,
    });

    // [2] ECR Repository
    const ecrRepo = new EcrRepo(this, 'Ecr', { userId });

    // [3] CodeBuild (auto-builds container image)
    const codeBuild = new CodeBuildInfra(this, 'CodeBuild', {
      repository: ecrRepo.repository,
      useStableGroot: props.useStableGroot,
    });

    // [4] Batch Compute Environment
    const batchCompute = new BatchComputeEnv(this, 'BatchCompute', {
      namePrefix,
      vpc: shared.vpc,
      privateSubnet: shared.privateSubnet,
      efsSecurityGroup: shared.efsSecurityGroup,
    });

    // [5] Job Queue + Job Definition
    const batchJob = new BatchJobDefinition(this, 'BatchJob', {
      namePrefix,
      computeEnvironment: batchCompute.computeEnvironment,
      efsFileSystemId: props.efsFileSystemId,
      repository: ecrRepo.repository,
    });

    // --- CloudFormation Outputs ---
    new cdk.CfnOutput(this, 'EcrRepositoryUri', {
      value: ecrRepo.repository.repositoryUri,
      description: 'ECR repository URI for GR00T fine-tuning container',
    });

    new cdk.CfnOutput(this, 'CodeBuildProjectName', {
      value: codeBuild.project.projectName,
      description: 'CodeBuild project name (for manual rebuild)',
    });

    new cdk.CfnOutput(this, 'JobQueueName', {
      value: batchJob.jobQueue.jobQueueName!,
      description: 'Batch Job Queue name for submitting training jobs',
    });

    new cdk.CfnOutput(this, 'JobDefinitionName', {
      value: batchJob.jobDefinition.jobDefinitionName!,
      description: 'Batch Job Definition name',
    });

    new cdk.CfnOutput(this, 'CheckpointPath', {
      value: '/mnt/efs/gr00t/checkpoints (Batch) = /home/ubuntu/environment/efs/gr00t/checkpoints (DCV)',
      description: 'Shared EFS path for model checkpoints',
    });

    new cdk.CfnOutput(this, 'SubmitJobExample', {
      value: [
        `aws batch submit-job`,
        `  --job-name groot-finetune`,
        `  --job-queue ${namePrefix}-GrootFinetuneQueue`,
        `  --job-definition ${namePrefix}-GrootFinetuneJob`,
        `  --container-overrides '{"environment":[{"name":"HF_TOKEN","value":"<your-hf-token>"},{"name":"MAX_STEPS","value":"6000"}]}'`,
      ].join(' '),
      description: 'Example AWS CLI command to submit a training job',
    });
  }
}
