import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { NetworkingConstruct } from './constructs/networking';
import { StorageConstruct } from './constructs/storage';
import { HyperPodClusterConstruct } from './constructs/hyperpod-cluster';
import { JumpHostConstruct } from './constructs/jump-host';
import { MlflowConstruct } from './constructs/mlflow';
import { DEFAULT_CLUSTER_CONFIG, DEFAULT_AMI_UPDATE_SCHEDULE, buildGpuGroups } from './config/cluster-config';

export interface HyperPodStackProps extends cdk.StackProps {
  userId: string;
  createVpc: boolean;
  vpcCidr: string;
  gpuMaxCountPerType: number;
  gpuUseSpot: boolean;
  fsxCapacityGiB: number;
}

export class HyperPodStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: HyperPodStackProps) {
    super(scope, id, props);

    const userId = props.userId;
    const userSuffix = userId ? `-${userId}` : '';
    const namePrefix = `HyperPod${userSuffix}`;

    cdk.Tags.of(this).add('Project', 'HyperPod');
    cdk.Tags.of(this).add('ManagedBy', 'CDK');
    if (userId) {
      cdk.Tags.of(this).add('UserId', userId);
    }

    const clusterConfig = {
      head: { ...DEFAULT_CLUSTER_CONFIG.head },
      gpu: buildGpuGroups('gpu', props.gpuMaxCountPerType, props.gpuUseSpot),
      debug: { ...DEFAULT_CLUSTER_CONFIG.debug },
    };

    // 1. Networking
    const networking = new NetworkingConstruct(this, 'Networking', {
      namePrefix,
      createVpc: props.createVpc,
      userId: props.userId,
      vpcCidr: props.vpcCidr,
    });

    // 2. Storage
    const storage = new StorageConstruct(this, 'Storage', {
      namePrefix,
      vpcId: networking.vpcId,
      privateSubnetId: networking.privateSubnetId,
      fsxCapacityGiB: props.fsxCapacityGiB,
    });

    // AMI 보안 패치 스케줄. 기본은 켜진 상태이며, 끄려면 -c amiUpdateSchedule=off 로 배포한다.
    const scheduleContext = this.node.tryGetContext('amiUpdateSchedule');
    const amiUpdateSchedule =
      scheduleContext === 'off' || scheduleContext === 'none'
        ? undefined
        : (scheduleContext ?? DEFAULT_AMI_UPDATE_SCHEDULE);

    // 3. HyperPod Cluster
    const cluster = new HyperPodClusterConstruct(this, 'HyperPod', {
      namePrefix,
      amiUpdateSchedule,
      vpcId: networking.vpcId,
      privateSubnetId: networking.privateSubnetId,
      fsxSecurityGroup: storage.securityGroup,
      dataBucket: storage.bucket,
      endpointSG: networking.endpointSG,
      ssmEndpoints: networking.ssmEndpoints,
      ...clusterConfig,
    });

    // 4. Jump Host for SSH access to cluster nodes
    const jumpHost = new JumpHostConstruct(this, 'JumpHost', {
      namePrefix,
      vpcId: networking.vpcId,
      publicSubnetId: networking.publicSubnetId,
      clusterSecurityGroupId: cluster.clusterSecurityGroupId,
      lifecycleBucketName: cluster.lifecycleBucket.ref,
    });

    // 5. MLflow - skip if already exists (handles orphaned resources from failed deploys)
    const enableMlflow = (this.node.tryGetContext('enableMlflow') ?? 'true') === 'true';
    if (enableMlflow) {
      new MlflowConstruct(this, 'MLflow', {
        namePrefix,
        artifactBucket: storage.bucket,
      });
    }

    // Stack Outputs
    new cdk.CfnOutput(this, 'S3BucketName', { value: storage.bucket.ref, description: 'Data S3 Bucket' });
    new cdk.CfnOutput(this, 'FsxFileSystemId', { value: storage.fileSystem.ref, description: 'FSx for Lustre File System ID' });
    new cdk.CfnOutput(this, 'VpcId', { value: networking.vpcId, description: 'VPC ID' });
    new cdk.CfnOutput(this, 'PrivateSubnetId', { value: networking.privateSubnetId, description: 'Private Subnet ID' });
    new cdk.CfnOutput(this, 'ClusterName', { value: cluster.clusterName, description: 'HyperPod Cluster Name' });
    new cdk.CfnOutput(this, 'LifecycleBucket', { value: cluster.lifecycleBucket.ref, description: 'Lifecycle Scripts S3 Bucket' });
  }
}
