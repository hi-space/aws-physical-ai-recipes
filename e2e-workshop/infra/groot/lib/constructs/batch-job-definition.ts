import * as cdk from 'aws-cdk-lib';
import * as batch from 'aws-cdk-lib/aws-batch';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface BatchJobDefinitionProps {
  namePrefix: string;
  computeEnvironment: batch.IManagedComputeEnvironment;
  efsFileSystemId: string;
  repository: ecr.IRepository;
  s3UploadUri: string;
}

export class BatchJobDefinition extends Construct {
  public readonly jobQueue: batch.JobQueue;
  public readonly jobDefinition: batch.EcsJobDefinition;
  public readonly multiNodeJobDefinition: batch.MultiNodeJobDefinition;

  constructor(scope: Construct, id: string, props: BatchJobDefinitionProps) {
    super(scope, id);

    // Job Queue
    this.jobQueue = new batch.JobQueue(this, 'JobQueue', {
      jobQueueName: `${props.namePrefix}-queue`,
      priority: 1,
      computeEnvironments: [
        { computeEnvironment: props.computeEnvironment, order: 1 },
      ],
    });

    // Job execution role
    const jobRole = new iam.Role(this, 'JobRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonElasticFileSystemFullAccess'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonS3FullAccess'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchLogsFullAccess'),
      ],
    });

    const baseEnvironment = {
      MAX_STEPS: '6000',
      SAVE_STEPS: '2000',
      GLOBAL_BATCH_SIZE: '32',
      LEARNING_RATE: '1e-4',
      GRADIENT_ACCUMULATION_STEPS: '1',
      BASE_MODEL_PATH: 'nvidia/GR00T-N1.6-3B',
      EMBODIMENT_TAG: 'new_embodiment',
      MODALITY_CONFIG_PATH: '/workspace/scripts/so101_modality_config.py',
      TUNE_LLM: 'false',
      TUNE_VISUAL: 'false',
      TUNE_PROJECTOR: 'true',
      TUNE_DIFFUSION_MODEL: 'true',
      OUTPUT_DIR: '/mnt/efs/gr00t/checkpoints',
      UPLOAD_TARGET: 's3',
      S3_UPLOAD_URI: props.s3UploadUri,
      REPORT_TO: 'tensorboard',
    };

    // --- Single-node Job Definition (1 GPU) ---
    const container = new batch.EcsEc2ContainerDefinition(this, 'Container', {
      image: ecs.ContainerImage.fromEcrRepository(props.repository, 'latest'),
      memory: cdk.Size.gibibytes(64),
      cpu: 8,
      gpu: 1,
      jobRole,
      environment: { ...baseEnvironment, NUM_GPUS: '1', NUM_NODES: '1' },
    });

    this.jobDefinition = new batch.EcsJobDefinition(this, 'JobDef', {
      jobDefinitionName: `${props.namePrefix}-job-single`,
      container,
      timeout: cdk.Duration.hours(6),
      retryAttempts: 1,
    });

    const cfnJobDef = this.jobDefinition.node.defaultChild as cdk.CfnResource;
    cfnJobDef.addPropertyOverride(
      'ContainerProperties.Volumes',
      [{ Name: 'efs-volume', EfsVolumeConfiguration: { FileSystemId: props.efsFileSystemId, RootDirectory: '/', TransitEncryption: 'ENABLED' } }],
    );
    cfnJobDef.addPropertyOverride(
      'ContainerProperties.MountPoints',
      [{ SourceVolume: 'efs-volume', ContainerPath: '/mnt/efs', ReadOnly: false }],
    );
    cfnJobDef.addPropertyOverride(
      'ContainerProperties.LinuxParameters',
      { SharedMemorySize: 65536 },
    );

    // --- Multi-node Job Definition (2 nodes × 1 GPU each) ---
    const multiNodeContainer = new batch.EcsEc2ContainerDefinition(this, 'MultiNodeContainer', {
      image: ecs.ContainerImage.fromEcrRepository(props.repository, 'latest'),
      memory: cdk.Size.gibibytes(60),
      cpu: 8,
      gpu: 1,
      jobRole,
      environment: {
        ...baseEnvironment,
        NUM_GPUS: '1',
        NUM_NODES: '2',
        DATALOADER_NUM_WORKERS: '2',
      },
    });

    this.multiNodeJobDefinition = new batch.MultiNodeJobDefinition(this, 'MultiNodeJobDef', {
      jobDefinitionName: `${props.namePrefix}-job-multinode`,
      mainNode: 0,
      propagateTags: true,
      containers: [
        { startNode: 0, endNode: 1, container: multiNodeContainer },
      ],
      timeout: cdk.Duration.hours(6),
      retryAttempts: 1,
    });

    // Add EFS volume + mount + shared memory to multi-node via L1 escape hatch
    const cfnMultiNodeJobDef = this.multiNodeJobDefinition.node.defaultChild as cdk.CfnResource;
    cfnMultiNodeJobDef.addPropertyOverride(
      'NodeProperties.NodeRangeProperties.0.Container.Volumes',
      [{ Name: 'efs-volume', EfsVolumeConfiguration: { FileSystemId: props.efsFileSystemId, RootDirectory: '/', TransitEncryption: 'ENABLED' } }],
    );
    cfnMultiNodeJobDef.addPropertyOverride(
      'NodeProperties.NodeRangeProperties.0.Container.MountPoints',
      [{ SourceVolume: 'efs-volume', ContainerPath: '/mnt/efs', ReadOnly: false }],
    );
    cfnMultiNodeJobDef.addPropertyOverride(
      'NodeProperties.NodeRangeProperties.0.Container.LinuxParameters',
      { SharedMemorySize: 65536 },
    );
  }
}
