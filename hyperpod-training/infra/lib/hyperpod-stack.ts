import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { NetworkingConstruct } from './constructs/networking';
import { StorageConstruct } from './constructs/storage';
import { HyperPodClusterConstruct } from './constructs/hyperpod-cluster';
import { JumpHostConstruct } from './constructs/jump-host';
import { MlflowConstruct } from './constructs/mlflow';
import {
  DEFAULT_CLUSTER_CONFIG,
  DEFAULT_AMI_UPDATE_SCHEDULE,
  buildGpuGroups,
  TRAIN_INSTANCE_PRESETS,
} from './config/cluster-config';

export interface HyperPodStackProps extends cdk.StackProps {
  userId: string;
  createVpc: boolean;
  vpcCidr: string;
  gpuMaxCountPerType: number;
  gpuUseSpot: boolean;
  /** 기본 학습 그룹(ml.g6e.12xlarge)에서 기동할 노드 수. 0 이면 노드 비용이 없다. */
  gpuCount: number;
  /** debug(DCV) 그룹에서 기동할 노드 수 (0 또는 1). */
  debugCount: number;
  fsxCapacityGiB: number;
  /** 기존 FSx for Lustre 재사용 (isaaclab 공유 FSx, createVpc=false 필요). */
  importedFsxId?: string;
  importedFsxMountName?: string;
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

    // HyperPod Slurm 은 job 제출 시 노드를 자동으로 올려주지 않는다. 그래서 실제로 쓰는
    // 그룹만 gpuCount/debugCount 로 명시적으로 기동하고, 나머지는 0 으로 정의만 남겨둔다
    // (노드가 0 인 그룹은 비용이 발생하지 않는다).
    const trainInstanceType = TRAIN_INSTANCE_PRESETS.default;
    const clusterConfig = {
      head: { ...DEFAULT_CLUSTER_CONFIG.head },
      gpu: buildGpuGroups('gpu', props.gpuMaxCountPerType, props.gpuUseSpot).map((g) =>
        g.instanceType === trainInstanceType ? { ...g, instanceCount: props.gpuCount } : g,
      ),
      debug: { ...DEFAULT_CLUSTER_CONFIG.debug, instanceCount: props.debugCount },
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
      importedFsxId: props.importedFsxId,
      importedFsxMountName: props.importedFsxMountName,
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
      fsxDnsName: storage.fsxDnsName,
      fsxMountName: storage.fsxMountName,
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

    // 5. MLflow (opt-in) - the workshop tracks RL runs via TensorBoard logs on FSx;
    //    provision a managed MLflow server only when explicitly requested
    const enableMlflow = (this.node.tryGetContext('enableMlflow') ?? 'false') === 'true';
    if (enableMlflow) {
      new MlflowConstruct(this, 'MLflow', {
        namePrefix,
        artifactBucket: storage.bucket,
      });
    }

    // Stack Outputs
    new cdk.CfnOutput(this, 'S3BucketName', { value: storage.bucket.ref, description: 'Data S3 Bucket' });
    new cdk.CfnOutput(this, 'FsxFileSystemId', { value: storage.fileSystemId, description: 'FSx for Lustre File System ID' });
    new cdk.CfnOutput(this, 'VpcId', { value: networking.vpcId, description: 'VPC ID' });
    new cdk.CfnOutput(this, 'PrivateSubnetId', { value: networking.privateSubnetId, description: 'Private Subnet ID' });
    new cdk.CfnOutput(this, 'ClusterName', { value: cluster.clusterName, description: 'HyperPod Cluster Name' });
    new cdk.CfnOutput(this, 'LifecycleBucket', { value: cluster.lifecycleBucket.ref, description: 'Lifecycle Scripts S3 Bucket' });
  }
}
