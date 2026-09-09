import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as eks from 'aws-cdk-lib/aws-eks';
import { KubectlV33Layer } from '@aws-cdk/lambda-layer-kubectl-v33';
import { Construct } from 'constructs';

export interface EksControlPlaneProps {
  namePrefix: string;
  /** EKS/HyperPod 클러스터 이름 (소문자). */
  clusterName: string;
  vpcCidr: string;
  version: eks.KubernetesVersion;
  /**
   * 클러스터 admin(AmazonEKSClusterAdminPolicy) 액세스 엔트리를 받을 IAM principal ARN.
   * 배포자(code-server의 DCV 인스턴스 롤 또는 개인 CLI 자격증명)와 -c eksAdminArns 목록.
   */
  adminPrincipalArns: string[];
}

/**
 * HyperPod EKS 경로의 컨트롤 플레인: VPC(2 AZ) + EKS 클러스터 + 액세스 엔트리.
 *
 * - EKS 컨트롤 플레인은 서브넷이 2개 AZ 이상 필요하므로 Slurm 경로의 단일 AZ NetworkingConstruct를
 *   쓰지 않고 L2 `ec2.Vpc`로 만든다. HyperPod 노드와 FSx는 AZ 0의 프라이빗 서브넷 하나에 둔다
 *   (FSx for Lustre는 단일 AZ이고, 노드-FSx 간 AZ 간 트래픽을 피한다).
 * - `clusterSecurityGroup`은 자기 참조 all-traffic 규칙을 가진 SG 하나로, EKS 컨트롤 플레인의 추가 SG와
 *   HyperPod 클러스터 VpcConfig 양쪽에 붙인다. HyperPod 노드는 VpcConfig에 지정한 SG만 받으므로,
 *   컨트롤 플레인 ENI와 노드가 같은 SG를 공유해야 kubelet(10250)·API(443) 통신이 열린다.
 * - 인증 모드 API: aws-auth ConfigMap 없이 액세스 엔트리로만 권한을 준다. HyperPod 실행 롤의
 *   HYPERPOD_LINUX 엔트리는 HyperPodEksClusterConstruct에서 만든다.
 */
export class EksControlPlaneConstruct extends Construct {
  public readonly vpc: ec2.Vpc;
  public readonly cluster: eks.Cluster;
  public readonly clusterSecurityGroup: ec2.SecurityGroup;
  /** HyperPod 노드·FSx가 들어가는 프라이빗 서브넷 (AZ 0). */
  public readonly hyperpodSubnet: ec2.ISubnet;
  /** `aws eks update-kubeconfig ...` (스택 Output KubeconfigCommand). */
  public readonly kubeconfigCommand: string;

  constructor(scope: Construct, id: string, props: EksControlPlaneProps) {
    super(scope, id);
    const p = props.namePrefix;

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      vpcName: `${p}-VPC`,
      ipAddresses: ec2.IpAddresses.cidr(props.vpcCidr),
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        { name: 'Public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        // VPC CNI는 파드마다 VPC IP를 쓰므로 프라이빗 서브넷은 넉넉하게 /20.
        { name: 'Private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 20 },
      ],
      gatewayEndpoints: {
        S3: { service: ec2.GatewayVpcEndpointAwsService.S3 },
      },
    });
    this.hyperpodSubnet = this.vpc.privateSubnets[0];

    this.clusterSecurityGroup = new ec2.SecurityGroup(this, 'ClusterSG', {
      vpc: this.vpc,
      securityGroupName: `${p}-Cluster-SG`,
      description: 'HyperPod EKS: control plane <-> HyperPod nodes, inter-node (NCCL/EFA)',
      allowAllOutbound: true,
    });
    this.clusterSecurityGroup.addIngressRule(
      this.clusterSecurityGroup,
      ec2.Port.allTraffic(),
      'Self: control plane, kubelet, inter-node',
    );

    this.cluster = new eks.Cluster(this, 'Cluster', {
      clusterName: props.clusterName,
      version: props.version,
      kubectlLayer: new KubectlV33Layer(this, 'KubectlLayer'),
      vpc: this.vpc,
      vpcSubnets: [{ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }],
      securityGroup: this.clusterSecurityGroup,
      // 노드는 전부 HyperPod가 공급한다. EKS 관리형 노드 그룹은 만들지 않는다.
      defaultCapacity: 0,
      authenticationMode: eks.AuthenticationMode.API,
      endpointAccess: eks.EndpointAccess.PUBLIC_AND_PRIVATE,
      clusterLogging: [
        eks.ClusterLoggingTypes.API,
        eks.ClusterLoggingTypes.AUDIT,
        eks.ClusterLoggingTypes.AUTHENTICATOR,
      ],
      tags: { Name: `${p}-EKS` },
    });

    const adminPolicy = eks.AccessPolicy.fromAccessPolicyName('AmazonEKSClusterAdminPolicy', {
      accessScopeType: eks.AccessScopeType.CLUSTER,
    });
    props.adminPrincipalArns.forEach((arn, i) => {
      this.cluster.grantAccess(`Admin${i}`, arn, [adminPolicy]);
    });

    this.kubeconfigCommand = `aws eks update-kubeconfig --name ${props.clusterName} --region ${cdk.Aws.REGION} --alias hyperpod-eks`;
  }
}
