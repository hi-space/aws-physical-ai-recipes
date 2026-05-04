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
}

export class BatchJobDefinition extends Construct {
  public readonly jobQueue: batch.JobQueue;
  public readonly jobDefinition: batch.EcsJobDefinition;

  constructor(scope: Construct, id: string, props: BatchJobDefinitionProps) {
    super(scope, id);

    // Job Queue
    this.jobQueue = new batch.JobQueue(this, 'JobQueue', {
      jobQueueName: `${props.namePrefix}-GrootFinetuneQueue`,
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

    // Container definition (without EFS volume at L2 - will add via escape hatch)
    const container = new batch.EcsEc2ContainerDefinition(this, 'Container', {
      image: ecs.ContainerImage.fromEcrRepository(props.repository, 'latest'),
      memory: cdk.Size.gibibytes(64),
      cpu: 8,
      gpu: 1,
      jobRole,
      environment: {
        OUTPUT_DIR: '/mnt/efs/gr00t/checkpoints',
        MAX_STEPS: '10000',
        SAVE_STEPS: '2000',
        NUM_GPUS: '1',
        BATCH_SIZE: '64',
        LEARNING_RATE: '1e-4',
        DATA_CONFIG: 'so100_dualcam',
        BASE_MODEL_PATH: 'nvidia/GR00T-N1.7-3B',
        EMBODIMENT_TAG: 'new_embodiment',
        TUNE_LLM: 'false',
        TUNE_VISUAL: 'false',
        TUNE_PROJECTOR: 'true',
        TUNE_DIFFUSION_MODEL: 'true',
        LORA_RANK: '0',
        UPLOAD_TARGET: 'none',
        REPORT_TO: 'tensorboard',
      },
    });

    this.jobDefinition = new batch.EcsJobDefinition(this, 'JobDef', {
      jobDefinitionName: `${props.namePrefix}-GrootFinetuneJob`,
      container,
      timeout: cdk.Duration.hours(6),
      retryAttempts: 1,
    });

    // Add EFS volume + mount via L1 escape hatch
    const cfnJobDef = this.jobDefinition.node.defaultChild as cdk.CfnResource;
    cfnJobDef.addPropertyOverride(
      'ContainerProperties.Volumes',
      [
        {
          Name: 'efs-volume',
          EfsVolumeConfiguration: {
            FileSystemId: props.efsFileSystemId,
            RootDirectory: '/',
            TransitEncryption: 'ENABLED',
          },
        },
      ],
    );
    cfnJobDef.addPropertyOverride(
      'ContainerProperties.MountPoints',
      [
        {
          SourceVolume: 'efs-volume',
          ContainerPath: '/mnt/efs',
          ReadOnly: false,
        },
      ],
    );
    // Shared memory for PyTorch DataLoader workers
    cfnJobDef.addPropertyOverride(
      'ContainerProperties.LinuxParameters',
      { SharedMemorySize: 65536 },
    );
  }
}
