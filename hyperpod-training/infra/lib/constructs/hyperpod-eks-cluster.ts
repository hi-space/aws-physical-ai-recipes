import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Asset } from 'aws-cdk-lib/aws-s3-assets';
import { Construct } from 'constructs';
import { InstanceGroupConfig } from '../config/cluster-config';

export interface HyperPodEksClusterProps {
  namePrefix: string;
  /** HyperPod 클러스터 이름 (소문자, EKS 클러스터와 동일). */
  clusterName: string;
  eksCluster: eks.Cluster;
  subnet: ec2.ISubnet;
  securityGroup: ec2.ISecurityGroup;
  /** 인스턴스 그룹. slurmNodeType/partitionName 은 EKS 에서 무시된다. */
  groups: InstanceGroupConfig[];
  /** GPU 그룹에 OnStartDeepHealthChecks(InstanceStress, InstanceConnectivity)를 켠다. 노드 기동이 길어진다. */
  deepHealthChecks: boolean;
}

/**
 * EKS 오케스트레이션 HyperPod 클러스터.
 *
 * 순서 의존성:
 *   HyperPodHelmChart(HMA, device plugin, training operator) → HYPERPOD_LINUX 액세스 엔트리 → 클러스터.
 * Helm 의존성이 먼저 깔려 있어야 첫 노드가 조인하면서 health-monitoring agent가 뜬다
 * (AWS 문서: "Helm 설치 없이 만들면 클러스터가 제대로 동작하지 않거나 생성이 실패할 수 있다").
 */
export class HyperPodEksClusterConstruct extends Construct {
  public readonly clusterName: string;
  public readonly clusterArn: string;
  public readonly clusterResource: cdk.CfnResource;
  public readonly executionRole: iam.Role;
  public readonly lifecycleBucket: s3.Bucket;
  public readonly helmChart: eks.HelmChart;

  constructor(scope: Construct, id: string, props: HyperPodEksClusterProps) {
    super(scope, id);
    const p = props.namePrefix;
    this.clusterName = props.clusterName;

    // --- 실행 롤 (문서: IAM role for SageMaker HyperPod — Amazon EKS) ---
    this.executionRole = new iam.Role(this, 'ExecutionRole', {
      assumedBy: new iam.ServicePrincipal('sagemaker.amazonaws.com'),
      description: 'HyperPod EKS instance group execution role',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSageMakerClusterInstanceRolePolicy'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonS3FullAccess'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonFSxFullAccess'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });
    this.executionRole.addToPolicy(new iam.PolicyStatement({
      sid: 'HyperPodEksNetworking',
      actions: [
        'ec2:AssignPrivateIpAddresses',
        'ec2:AttachNetworkInterface',
        'ec2:CreateNetworkInterface',
        'ec2:CreateNetworkInterfacePermission',
        'ec2:DeleteNetworkInterface',
        'ec2:DeleteNetworkInterfacePermission',
        'ec2:DescribeInstances',
        'ec2:DescribeInstanceTypes',
        'ec2:DescribeNetworkInterfaces',
        'ec2:DescribeTags',
        'ec2:DescribeVpcs',
        'ec2:DescribeDhcpOptions',
        'ec2:DescribeSubnets',
        'ec2:DescribeSecurityGroups',
        'ec2:DetachNetworkInterface',
        'ec2:ModifyNetworkInterfaceAttribute',
        'ec2:UnassignPrivateIpAddresses',
        'ecr:BatchCheckLayerAvailability',
        'ecr:BatchGetImage',
        'ecr:GetAuthorizationToken',
        'ecr:GetDownloadUrlForLayer',
        'eks-auth:AssumeRoleForPodIdentity',
      ],
      resources: ['*'],
    }));
    this.executionRole.addToPolicy(new iam.PolicyStatement({
      sid: 'HyperPodEksEniTags',
      actions: ['ec2:CreateTags'],
      resources: ['arn:aws:ec2:*:*:network-interface/*'],
    }));

    // 노드가 EKS API에 kubelet 으로 조인하기 위한 액세스 엔트리 (Kubernetes 그룹/정책 없음).
    const nodeAccess = new eks.AccessEntry(this, 'NodeAccessEntry', {
      cluster: props.eksCluster,
      principal: this.executionRole.roleArn,
      accessEntryType: eks.AccessEntryType.HYPERPOD_LINUX,
      accessPolicies: [],
    });

    // --- HyperPod Helm 의존성 (vendored chart, infra 밖 eks/helm) ---
    const chartAsset = new Asset(this, 'HelmChartAsset', {
      path: path.join(__dirname, '..', '..', '..', 'eks', 'helm', 'HyperPodHelmChart'),
    });
    this.helmChart = props.eksCluster.addHelmChart('HyperPodDependencies', {
      chartAsset,
      release: 'hyperpod-dependencies',
      namespace: 'kube-system',
      createNamespace: false,
      wait: false,
      timeout: cdk.Duration.minutes(15),
      values: {
        'health-monitoring-agent': {
          region: cdk.Aws.REGION,
          debug: false,
        },
      },
    });

    // --- lifecycle 버킷: on_create_eks.sh 하나만 올린다 ---
    this.lifecycleBucket = new s3.Bucket(this, 'LifecycleBucket', {
      bucketName: cdk.Fn.join('-', ['hyperpod-eks-lifecycle', cdk.Aws.ACCOUNT_ID, cdk.Aws.REGION]),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      enforceSSL: true,
    });
    const lifecycleDeploy = new s3deploy.BucketDeployment(this, 'LifecycleScriptsDeploy', {
      sources: [
        s3deploy.Source.asset(path.join(__dirname, '..', '..', '..', 'lifecycle-scripts'), {
          exclude: ['**', '!on_create_eks.sh'],
        }),
      ],
      destinationBucket: this.lifecycleBucket,
      destinationKeyPrefix: 'lifecycle-scripts/',
    });

    const buildInstanceGroup = (g: InstanceGroupConfig) => ({
      InstanceGroupName: g.name,
      InstanceType: g.instanceType,
      InstanceCount: g.instanceCount,
      LifeCycleConfig: {
        SourceS3Uri: `s3://${this.lifecycleBucket.bucketName}/lifecycle-scripts/`,
        OnCreate: 'on_create_eks.sh',
      },
      ExecutionRole: this.executionRole.roleArn,
      ...(props.deepHealthChecks && /^ml\.(g|p)/.test(g.instanceType)
        ? { OnStartDeepHealthChecks: ['InstanceStress', 'InstanceConnectivity'] }
        : {}),
    });

    this.clusterResource = new cdk.CfnResource(this, 'Cluster', {
      type: 'AWS::SageMaker::Cluster',
      properties: {
        ClusterName: this.clusterName,
        Orchestrator: { Eks: { ClusterArn: props.eksCluster.clusterArn } },
        // Continuous: 그룹이 InService 를 유지한 채 노드를 더하고 빼며, 실패한 노드만 재시도한다.
        // EKS 전용이며 Karpenter 오토스케일링의 전제 조건이다.
        NodeProvisioningMode: 'Continuous',
        NodeRecovery: 'Automatic',
        InstanceGroups: props.groups.map(buildInstanceGroup),
        VpcConfig: {
          SecurityGroupIds: [props.securityGroup.securityGroupId],
          Subnets: [props.subnet.subnetId],
        },
        Tags: [{ Key: 'Name', Value: `${p}-Cluster` }],
      },
    });
    this.clusterArn = this.clusterResource.getAtt('ClusterArn').toString();
    this.clusterResource.node.addDependency(this.helmChart);
    this.clusterResource.node.addDependency(nodeAccess);
    this.clusterResource.node.addDependency(lifecycleDeploy);
  }
}
