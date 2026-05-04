import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as iam from 'aws-cdk-lib/aws-iam';
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
  public readonly clusterName: string;
  public readonly clusterSecurityGroupId: string;
  public readonly secretsCsiAddon: eks.CfnAddon;

  constructor(scope: Construct, id: string, props: EksClusterProps) {
    super(scope, id);

    const p = props.namePrefix;
    const gpuSimMax = props.gpuSimMaxNodes ?? 8;
    const gpuTrainMax = props.gpuTrainMaxNodes ?? 4;

    // EKS Cluster Role
    const clusterRole = new iam.CfnRole(this, 'ClusterRole', {
      assumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [{
          Effect: 'Allow',
          Principal: { Service: 'eks.amazonaws.com' },
          Action: 'sts:AssumeRole',
        }],
      },
      managedPolicyArns: [
        'arn:aws:iam::aws:policy/AmazonEKSClusterPolicy',
        'arn:aws:iam::aws:policy/AmazonEKSVPCResourceController',
      ],
    });

    // EKS Cluster (L1 — no Lambda Custom Resource)
    this.clusterName = `${p}-eks`.toLowerCase();
    const cluster = new eks.CfnCluster(this, 'Cluster', {
      name: this.clusterName,
      version: '1.30',
      roleArn: clusterRole.attrArn,
      resourcesVpcConfig: {
        subnetIds: [
          ...props.privateSubnets.map(s => s.ref),
          ...props.publicSubnets.map(s => s.ref),
        ],
        endpointPublicAccess: true,
        endpointPrivateAccess: true,
      },
      accessConfig: {
        authenticationMode: 'API_AND_CONFIG_MAP',
      },
    });

    this.clusterSecurityGroupId = cluster.attrClusterSecurityGroupId;

    // Access Entry — deployer user
    new eks.CfnAccessEntry(this, 'AdminAccess', {
      clusterName: this.clusterName,
      principalArn: `arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:user/yoo`,
      accessPolicies: [{
        policyArn: 'arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy',
        accessScope: { type: 'cluster' },
      }],
    });
    (this.node.findChild('AdminAccess') as cdk.CfnResource).addDependency(cluster);

    // Node Group Role
    const nodeRole = new iam.CfnRole(this, 'NodeRole', {
      assumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [{
          Effect: 'Allow',
          Principal: { Service: 'ec2.amazonaws.com' },
          Action: 'sts:AssumeRole',
        }],
      },
      managedPolicyArns: [
        'arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy',
        'arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy',
        'arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly',
        'arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore',
        'arn:aws:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy',
      ],
    });

    // System node group
    const systemNg = new eks.CfnNodegroup(this, 'SystemNodes', {
      clusterName: this.clusterName,
      nodegroupName: 'system',
      nodeRole: nodeRole.attrArn,
      subnets: props.privateSubnets.map(s => s.ref),
      instanceTypes: ['m5.xlarge'],
      scalingConfig: { minSize: 2, maxSize: 3, desiredSize: 2 },
      labels: { 'node-role': 'system' },
    });
    systemNg.addDependency(cluster);

    // GPU Sim node group (4×A10G/L4 — fallback across similar GPU instances)
    const gpuSimNg = new eks.CfnNodegroup(this, 'GpuSimNodes', {
      clusterName: this.clusterName,
      nodegroupName: 'gpu-sim',
      nodeRole: nodeRole.attrArn,
      subnets: props.privateSubnets.map(s => s.ref),
      instanceTypes: ['g5.12xlarge', 'g6.12xlarge', 'g5.24xlarge'],
      scalingConfig: { minSize: 0, maxSize: gpuSimMax, desiredSize: 0 },
      diskSize: 200,
      labels: { 'node-role': 'gpu-sim', 'nvidia.com/gpu.product': 'L4' },
      taints: [{
        key: 'nvidia.com/gpu',
        value: 'present',
        effect: 'NO_SCHEDULE',
      }],
      amiType: 'AL2023_x86_64_NVIDIA',
    });
    gpuSimNg.addDependency(cluster);

    // GPU Train node group (4×L40S — fallback to larger instances if capacity unavailable)
    const gpuTrainNg = new eks.CfnNodegroup(this, 'GpuTrainNodes', {
      clusterName: this.clusterName,
      nodegroupName: 'gpu-train',
      nodeRole: nodeRole.attrArn,
      subnets: props.privateSubnets.map(s => s.ref),
      instanceTypes: ['g6e.12xlarge', 'g6e.16xlarge', 'g6e.24xlarge'],
      scalingConfig: { minSize: 0, maxSize: gpuTrainMax, desiredSize: 0 },
      diskSize: 200,
      labels: { 'node-role': 'gpu-train', 'nvidia.com/gpu.product': 'L40S' },
      taints: [{
        key: 'nvidia.com/gpu',
        value: 'present',
        effect: 'NO_SCHEDULE',
      }],
      amiType: 'AL2023_x86_64_NVIDIA',
    });
    gpuTrainNg.addDependency(cluster);

    // EKS Managed Addons (L1 — no Lambda)
    this.secretsCsiAddon = new eks.CfnAddon(this, 'SecretsCsiAddon', {
      clusterName: this.clusterName,
      addonName: 'aws-secrets-store-csi-driver-provider',
    });
    this.secretsCsiAddon.addDependency(cluster);

    const ebsCsiAddon = new eks.CfnAddon(this, 'EbsCsiAddon', {
      clusterName: this.clusterName,
      addonName: 'aws-ebs-csi-driver',
    });
    ebsCsiAddon.addDependency(cluster);
  }
}
