import * as cdk from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import { Construct } from 'constructs';
import { SharedResourceImporter } from './constructs/shared-resource-importer';
import { BatchComputeEnv } from './constructs/batch-compute-env';
import { BatchJobDefinition } from './constructs/batch-job-definition';

export interface GrootBatchTrainStackProps extends cdk.StackProps {
  vpcId: string;
  efsFileSystemId: string;
  efsSecurityGroupId: string;
  privateSubnetId: string;
  availabilityZone: string;
  userId?: string;
}

export class GrootBatchTrainStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: GrootBatchTrainStackProps) {
    super(scope, id, props);

    const { userId } = props;
    const namePrefix = userId ? `groot-batch-train-${userId}` : 'groot-batch-train';

    cdk.Tags.of(this).add('Project', 'GrootBatchTrain');
    if (userId) cdk.Tags.of(this).add('UserId', userId);

    // [1] Import shared VPC/EFS/Subnet from IsaacLab parent stack
    const shared = new SharedResourceImporter(this, 'SharedResources', {
      vpcId: props.vpcId,
      efsFileSystemId: props.efsFileSystemId,
      efsSecurityGroupId: props.efsSecurityGroupId,
      privateSubnetId: props.privateSubnetId,
      availabilityZone: props.availabilityZone,
    });

    // [2] Import shared ECR repository (created by GrootBatchTrainShared stack)
    const sharedRepository = ecr.Repository.fromRepositoryName(
      this,
      'SharedEcr',
      'groot-batch-train',
    );

    // [3] Batch Compute Environment
    const batchCompute = new BatchComputeEnv(this, 'BatchCompute', {
      namePrefix,
      vpc: shared.vpc,
      privateSubnet: shared.privateSubnet,
      efsSecurityGroup: shared.efsSecurityGroup,
    });

    // [4] Job Queue + Job Definition
    const batchJob = new BatchJobDefinition(this, 'BatchJob', {
      namePrefix,
      computeEnvironment: batchCompute.computeEnvironment,
      efsFileSystemId: props.efsFileSystemId,
      repository: sharedRepository,
    });

    // --- CloudFormation Outputs ---
    new cdk.CfnOutput(this, 'JobQueueName', {
      value: batchJob.jobQueue.jobQueueName!,
      description: 'Batch Job Queue name for submitting training jobs',
    });

    new cdk.CfnOutput(this, 'JobDefinitionName', {
      value: batchJob.jobDefinition.jobDefinitionName!,
      description: 'Batch Job Definition name (single-node)',
    });

    new cdk.CfnOutput(this, 'MultiNodeJobDefinitionName', {
      value: batchJob.multiNodeJobDefinition.jobDefinitionName,
      description: 'Batch Job Definition name (multi-node distributed)',
    });

    new cdk.CfnOutput(this, 'CheckpointPath', {
      value: '/mnt/efs/gr00t/checkpoints (Batch) = /home/ubuntu/environment/efs/gr00t/checkpoints (DCV)',
      description: 'Shared EFS path for model checkpoints',
    });

    new cdk.CfnOutput(this, 'SubmitJobExample', {
      value: [
        `aws batch submit-job`,
        `  --job-name groot-batch-train`,
        `  --job-queue ${namePrefix}-queue`,
        `  --job-definition ${namePrefix}-job-single`,
        `  --container-overrides '{"environment":[{"name":"HF_TOKEN","value":"<your-hf-token>"},{"name":"MAX_STEPS","value":"6000"}]}'`,
      ].join(' '),
      description: 'Example AWS CLI command to submit a training job',
    });
  }
}
