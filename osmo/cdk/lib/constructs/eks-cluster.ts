import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as iam from 'aws-cdk-lib/aws-iam';
import { KubectlV30Layer } from '@aws-cdk/lambda-layer-kubectl-v30';
import { Construct } from 'constructs';

export interface EksClusterProps {
  namePrefix: string;
  vpc: ec2.CfnVPC;
  privateSubnets: ec2.CfnSubnet[];
  publicSubnets: ec2.CfnSubnet[];
  gpuSimMaxNodes?: number;
  gpuTrainMaxNodes?: number;
}

export class EksClusterConstruct extends Construct {
  public readonly cluster: eks.Cluster;
  public readonly clusterName: string;
  public readonly oidcProviderArn: string;

  constructor(scope: Construct, id: string, props: EksClusterProps) {
    super(scope, id);

    const p = props.namePrefix;
    const gpuSimMax = props.gpuSimMaxNodes ?? 8;
    const gpuTrainMax = props.gpuTrainMaxNodes ?? 4;

    // EKS Cluster (L2 construct for kubectl/Helm integration)
    // L1 CfnVPC/CfnSubnet → L2 IVpc 브릿지: fromVpcAttributes로 연결
    this.cluster = new eks.Cluster(this, 'Cluster', {
      clusterName: `${p}-eks`.toLowerCase(),
      version: eks.KubernetesVersion.V1_30,
      defaultCapacity: 0,
      kubectlLayer: new KubectlV30Layer(this, 'KubectlLayer'),
      vpc: ec2.Vpc.fromVpcAttributes(this, 'ImportVpc', {
        vpcId: props.vpc.ref,
        availabilityZones: props.privateSubnets.map(s => s.attrAvailabilityZone),
        privateSubnetIds: props.privateSubnets.map(s => s.ref),
        publicSubnetIds: props.publicSubnets.map(s => s.ref),
      }),
      endpointAccess: eks.EndpointAccess.PUBLIC_AND_PRIVATE,
    });

    this.clusterName = this.cluster.clusterName;
    this.oidcProviderArn = this.cluster.openIdConnectProvider.openIdConnectProviderArn;

    // --- Node Groups ---

    // System node group (OSMO control plane, ingress, etc.)
    this.cluster.addNodegroupCapacity('SystemNodes', {
      nodegroupName: 'system',
      instanceTypes: [new ec2.InstanceType('m5.xlarge')],
      minSize: 2,
      maxSize: 3,
      desiredSize: 2,
      labels: { 'node-role': 'system' },
    });

    // GPU Sim node group (g5.12xlarge, 4×L4)
    this.cluster.addNodegroupCapacity('GpuSimNodes', {
      nodegroupName: 'gpu-sim',
      instanceTypes: [new ec2.InstanceType('g5.12xlarge')],
      minSize: 0,
      maxSize: gpuSimMax,
      desiredSize: 0,
      labels: { 'node-role': 'gpu-sim', 'nvidia.com/gpu.product': 'L4' },
      taints: [{
        key: 'nvidia.com/gpu',
        value: 'present',
        effect: eks.TaintEffect.NO_SCHEDULE,
      }],
      amiType: eks.NodegroupAmiType.AL2_X86_64_GPU,
    });

    // GPU Train node group (g6e.12xlarge, 4×L40S)
    this.cluster.addNodegroupCapacity('GpuTrainNodes', {
      nodegroupName: 'gpu-train',
      instanceTypes: [new ec2.InstanceType('g6e.12xlarge')],
      minSize: 0,
      maxSize: gpuTrainMax,
      desiredSize: 0,
      labels: { 'node-role': 'gpu-train', 'nvidia.com/gpu.product': 'L40S' },
      taints: [{
        key: 'nvidia.com/gpu',
        value: 'present',
        effect: eks.TaintEffect.NO_SCHEDULE,
      }],
      amiType: eks.NodegroupAmiType.AL2_X86_64_GPU,
    });

    // NVIDIA Device Plugin DaemonSet
    this.cluster.addHelmChart('NvidiaDevicePlugin', {
      chart: 'nvidia-device-plugin',
      repository: 'https://nvidia.github.io/k8s-device-plugin',
      namespace: 'kube-system',
      values: {
        tolerations: [{
          key: 'nvidia.com/gpu',
          operator: 'Exists',
          effect: 'NoSchedule',
        }],
      },
    });

    // Cluster Autoscaler — IRSA (IAM Roles for Service Accounts)
    const autoscalerSa = this.cluster.addServiceAccount('AutoscalerSA', {
      name: 'cluster-autoscaler',
      namespace: 'kube-system',
    });
    autoscalerSa.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: [
        'autoscaling:DescribeAutoScalingGroups',
        'autoscaling:DescribeAutoScalingInstances',
        'autoscaling:DescribeLaunchConfigurations',
        'autoscaling:DescribeScalingActivities',
        'autoscaling:DescribeTags',
        'autoscaling:SetDesiredCapacity',
        'autoscaling:TerminateInstanceInAutoScalingGroup',
        'ec2:DescribeLaunchTemplateVersions',
        'ec2:DescribeInstanceTypes',
        'eks:DescribeNodegroup',
      ],
      resources: ['*'],
    }));

    this.cluster.addHelmChart('ClusterAutoscaler', {
      chart: 'cluster-autoscaler',
      repository: 'https://kubernetes.github.io/autoscaler',
      namespace: 'kube-system',
      values: {
        autoDiscovery: {
          clusterName: this.cluster.clusterName,
        },
        awsRegion: cdk.Aws.REGION,
        rbac: {
          serviceAccount: {
            create: false,
            name: 'cluster-autoscaler',
          },
        },
        extraArgs: {
          'scale-down-delay-after-add': '10m',
          'scale-down-unneeded-time': '10m',
        },
      },
    });
  }
}
