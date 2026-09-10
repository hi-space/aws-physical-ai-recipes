import * as cdk from 'aws-cdk-lib';
import * as eks from 'aws-cdk-lib/aws-eks';
import { Construct } from 'constructs';
import { EksControlPlaneConstruct } from './constructs/eks-control-plane';
import { HyperPodEksClusterConstruct } from './constructs/hyperpod-eks-cluster';
import { FsxCsiConstruct } from './constructs/fsx-csi';
import { GrafanaMode, ObservabilityConstruct } from './constructs/observability';
import { StorageConstruct } from './constructs/storage';
import {
  buildGpuGroups,
  CPU_TRAIN_INSTANCE_TYPE,
  GpuGroupProfile,
  InstanceGroupConfig,
  TRAIN_INSTANCE_PRESETS,
} from './config/cluster-config';

export interface HyperPodEksStackProps extends cdk.StackProps {
  accountId: string;
  vpcCidr: string;
  /** Kubernetes 버전 문자열. 기본 1.34 (constructs/eks-control-plane.ts SUPPORTED_EKS_VERSIONS). */
  eksVersion: string;
  /** 클러스터 admin 액세스 엔트리를 받을 principal ARN(배포자 + -c eksAdminArns). */
  eksAdminArns: string[];
  gpuMaxCountPerType: number;
  gpuUseSpot: boolean;
  gpuGroups: GpuGroupProfile;
  /** 기본 학습 그룹(gpu-g5-8x)에서 기동할 노드 수. */
  gpuCount: number;
  /**
   * 상시 시스템 노드(cpu-c5-4x, ml.c5.4xlarge) 수. observability / task governance 애드온은 HyperPod 노드가
   * 1대 이상(4xlarge 이상) 있어야 설치되므로 기본 1. 이 그룹은 MuJoCo CPU 학습(모듈 9)에도 쓰며, 모듈 11 이 scale-cluster.sh 로 2대로 올린다.
   */
  systemNodeCount: number;
  fsxCapacityGiB: number;
  enableObservability: boolean;
  enableTaskGovernance: boolean;
  /** self-hosted(기본) | amg | none — constructs/observability.ts GrafanaMode 참고. */
  grafanaMode: GrafanaMode;
  deepHealthChecks: boolean;
}

/** 상시 시스템 노드 그룹 이름 (Slurm 경로의 cpu-c5-4x 와 같은 타입·이름). */
export const SYSTEM_GROUP_NAME = 'cpu-c5-4x';

/**
 * HyperPodEks-<ACCOUNT_ID>: EKS 오케스트레이션 HyperPod 스택 (RL 트랙 모듈 8–11).
 *
 * Slurm 스택(HyperPod-<ACCOUNT_ID>)과 독립적으로 자체 VPC·FSx·버킷을 가지며 한 계정에 공존할 수 있다.
 */
export class HyperPodEksStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: HyperPodEksStackProps) {
    super(scope, id, props);

    const accountSuffix = props.accountId ? `-${props.accountId}` : '';
    const namePrefix = `HyperPodEks${accountSuffix}`;
    // 클러스터 이름은 Slurm 경로(hyperpod-<ACCOUNT_ID>)와 나란히 읽히도록 hyperpod-eks-<ACCOUNT_ID>.
    const clusterName = `hyperpod-eks${accountSuffix}`.toLowerCase();

    cdk.Tags.of(this).add('Project', 'HyperPod');
    cdk.Tags.of(this).add('Orchestrator', 'EKS');
    cdk.Tags.of(this).add('ManagedBy', 'CDK');
    if (props.accountId) {
      cdk.Tags.of(this).add('UserId', props.accountId);
    }

    const trainInstanceType = TRAIN_INSTANCE_PRESETS.default;
    const systemGroup: InstanceGroupConfig = {
      name: SYSTEM_GROUP_NAME,
      instanceType: CPU_TRAIN_INSTANCE_TYPE,
      instanceCount: props.systemNodeCount,
      maxCount: 2,
      useSpot: false,
      slurmNodeType: 'Compute',
    };
    const gpuGroups = buildGpuGroups('gpu', props.gpuMaxCountPerType, props.gpuUseSpot, props.gpuGroups).map((g) =>
      g.instanceType === trainInstanceType ? { ...g, instanceCount: props.gpuCount } : g,
    );

    // 1. VPC + EKS 컨트롤 플레인
    const controlPlane = new EksControlPlaneConstruct(this, 'Eks', {
      namePrefix,
      clusterName,
      vpcCidr: props.vpcCidr,
      version: props.eksVersion,
      adminPrincipalArns: props.eksAdminArns,
    });

    const podIdentityAgent = new eks.CfnAddon(this, 'PodIdentityAgent', {
      clusterName: controlPlane.cluster.clusterName,
      addonName: 'eks-pod-identity-agent',
      resolveConflicts: 'OVERWRITE',
    });

    // 2. S3 + FSx for Lustre (+ DRA datasets/checkpoints/enroot) — Slurm 스택과 같은 construct
    const storage = new StorageConstruct(this, 'Storage', {
      namePrefix,
      vpcId: controlPlane.vpc.vpcId,
      privateSubnetId: controlPlane.hyperpodSubnet.subnetId,
      fsxCapacityGiB: props.fsxCapacityGiB,
      vpcCidr: props.vpcCidr,
      bucketPrefix: 'hyperpod-eks-data',
    });

    // 3. HyperPod 클러스터 (Helm 의존성 → 액세스 엔트리 → 클러스터)
    const hyperpod = new HyperPodEksClusterConstruct(this, 'HyperPod', {
      namePrefix,
      clusterName,
      eksCluster: controlPlane.cluster,
      subnet: controlPlane.hyperpodSubnet,
      securityGroup: controlPlane.clusterSecurityGroup,
      groups: [systemGroup, ...gpuGroups],
      deepHealthChecks: props.deepHealthChecks,
    });

    // 4. FSx CSI + 정적 PV
    new FsxCsiConstruct(this, 'FsxCsi', { eksCluster: controlPlane.cluster, podIdentityAgent });

    // 5. Observability (AMP + AMG + 애드온) / Task governance 애드온
    const observability = new ObservabilityConstruct(this, 'Observability', {
      namePrefix,
      eksCluster: controlPlane.cluster,
      hyperpodCluster: hyperpod.clusterResource,
      podIdentityAgent,
      enableObservability: props.enableObservability,
      enableTaskGovernance: props.enableTaskGovernance,
      grafanaMode: props.grafanaMode,
    });

    new cdk.CfnOutput(this, 'EksClusterName', { value: controlPlane.cluster.clusterName, description: 'EKS cluster name' });
    new cdk.CfnOutput(this, 'KubeconfigCommand', { value: controlPlane.kubeconfigCommand, description: 'Configure kubectl for the HyperPod EKS cluster' });
    if (observability.ampWorkspace) {
      new cdk.CfnOutput(this, 'AmpWorkspaceId', { value: observability.ampWorkspace.attrWorkspaceId, description: 'Amazon Managed Service for Prometheus workspace ID' });
      new cdk.CfnOutput(this, 'AmpEndpoint', { value: observability.ampWorkspace.attrPrometheusEndpoint, description: 'AMP query/remote-write endpoint' });
    }
    new cdk.CfnOutput(this, 'GrafanaMode', { value: props.grafanaMode, description: 'self-hosted | amg | none' });
    if (observability.grafanaWorkspace && observability.grafanaUrl) {
      new cdk.CfnOutput(this, 'GrafanaWorkspaceId', { value: observability.grafanaWorkspace.attrId, description: 'Amazon Managed Grafana workspace ID' });
      new cdk.CfnOutput(this, 'GrafanaUrl', { value: observability.grafanaUrl, description: 'Grafana URL (sign in with an IAM Identity Center user assigned via scripts/eks/grafana-user.sh)' });
    }
    if (observability.grafanaAccessCommand) {
      new cdk.CfnOutput(this, 'GrafanaAccess', { value: observability.grafanaAccessCommand, description: 'In-cluster Grafana: port-forward and admin password' });
    }
    new cdk.CfnOutput(this, 'ClusterName', { value: hyperpod.clusterName, description: 'HyperPod cluster name (EKS orchestrated)' });
    new cdk.CfnOutput(this, 'ClusterArn', { value: hyperpod.clusterArn, description: 'HyperPod cluster ARN (task governance policies need it)' });
    new cdk.CfnOutput(this, 'S3BucketName', { value: storage.bucket.ref, description: 'Data S3 bucket (FSx DRA: datasets/, checkpoints/, enroot/)' });
    new cdk.CfnOutput(this, 'FsxFileSystemId', { value: storage.fileSystemId, description: 'FSx for Lustre file system ID' });
    new cdk.CfnOutput(this, 'FsxDnsName', { value: storage.fsxDnsName, description: 'FSx for Lustre DNS name (PV volumeAttributes.dnsname)' });
    new cdk.CfnOutput(this, 'FsxMountName', { value: storage.fsxMountName, description: 'FSx for Lustre mount name (PV volumeAttributes.mountname)' });
    new cdk.CfnOutput(this, 'VpcId', { value: controlPlane.vpc.vpcId, description: 'VPC ID' });
    new cdk.CfnOutput(this, 'LifecycleBucket', { value: hyperpod.lifecycleBucket.bucketName, description: 'Lifecycle scripts bucket' });
    new cdk.CfnOutput(this, 'Orchestrator', { value: 'eks', description: 'HyperPod orchestrator' });
  }
}
