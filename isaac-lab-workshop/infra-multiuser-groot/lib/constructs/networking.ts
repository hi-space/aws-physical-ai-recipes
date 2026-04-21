/**
 * NetworkingConstruct
 *
 * VPC, 서브넷, IGW, NAT Gateway, S3 VPC Endpoint, VPC Flow Log,
 * DCV용 보안 그룹을 생성하는 L1 Construct.
 *
 * L1 Construct(Cfn* 클래스)를 사용하여 원본 CloudFormation 템플릿과
 * 1:1 대응을 유지하고, CDK synth 결과를 예측 가능하게 한다.
 */
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

/**
 * NetworkingConstruct Props
 */
export interface NetworkingProps {
  /** 리소스 Name 태그 접두사 (예: 'IsaacLab-Stable-alice') */
  namePrefix: string;
  /** AZ 선택: 'auto' (Fn::Select(0)), '0'~'5' (인덱스), 또는 AZ 이름 직접 지정 (예: 'us-east-1b') */
  preferredAZ: string;
  /** DCV 보안 그룹 인바운드 소스 CIDR (기본값: '0.0.0.0/0') */
  allowedCidr: string;
  /** Custom Resource에서 탐색된 AZ 이름 (선택, 이 값이 있으면 preferredAZ보다 우선) */
  resolvedAZ?: string;
  /** VPC CIDR (기본값: '10.0.0.0/16') — 서브넷 CIDR은 자동 계산 */
  vpcCidr?: string;
  /** GR00T 활성화 여부 (SG에 ZMQ/DDS 포트 추가) */
  enableGroot?: boolean;
  /** code-server 활성화 여부 (SG에 8888 포트 추가, 기본값: true) */
  enableCodeServer?: boolean;
}

/**
 * 네트워크 인프라를 구성하는 Construct
 *
 * 생성 리소스:
 * - VPC (10.0.0.0/16, DNS 지원/호스트네임 활성화)
 * - 퍼블릭 서브넷 (10.0.0.0/24) + IGW + 라우트 테이블
 * - 프라이빗 서브넷 (10.0.1.0/24) + NAT Gateway + EIP + 라우트 테이블
 * - S3 VPC Endpoint (Gateway 타입)
 * - VPC Flow Log → CloudWatch Logs
 * - DCV용 보안 그룹 (SSH, DCV HTTP, DCV HTTPS)
 */
export class NetworkingConstruct extends Construct {
  /** VPC 리소스 */
  public readonly vpc: ec2.CfnVPC;
  /** 퍼블릭 서브넷 */
  public readonly publicSubnet: ec2.CfnSubnet;
  /** 프라이빗 서브넷 */
  public readonly privateSubnet: ec2.CfnSubnet;
  /** DCV용 보안 그룹 */
  public readonly dcvSecurityGroup: ec2.CfnSecurityGroup;
  /** VPC Flow Log용 CloudWatch Logs 로그 그룹 */
  public readonly logGroup: logs.CfnLogGroup;

  constructor(scope: Construct, id: string, props: NetworkingProps) {
    super(scope, id);

    // --- AZ 선택 로직 ---
    // resolvedAZ가 있으면 Custom Resource에서 탐색된 AZ 사용 (capacity 확인됨)
    // 없으면 기존 로직: 'auto'이면 첫 번째 AZ, '0'~'5'이면 해당 인덱스 AZ
    let selectedAZ: string;
    if (props.resolvedAZ) {
      selectedAZ = props.resolvedAZ;
    } else {
      const azIndex = props.preferredAZ === 'auto' ? 0 : parseInt(props.preferredAZ, 10);
      selectedAZ = cdk.Fn.select(azIndex, cdk.Fn.getAzs(''));
    }

    // --- VPC CIDR 및 서브넷 CIDR 계산 ---
    // vpcCidr에서 처음 두 옥텟을 추출하여 서브넷 CIDR을 자동 계산
    // 예: 10.1.0.0/16 → 퍼블릭 10.1.0.0/24, 프라이빗 10.1.1.0/24
    const vpcCidr = props.vpcCidr ?? '10.0.0.0/16';
    const cidrPrefix = vpcCidr.split('.').slice(0, 2).join('.');
    const publicSubnetCidr = `${cidrPrefix}.0.0/24`;
    const privateSubnetCidr = `${cidrPrefix}.1.0/24`;

    const p = props.namePrefix;

    // --- VPC ---
    this.vpc = new ec2.CfnVPC(this, 'VPC', {
      cidrBlock: vpcCidr,
      enableDnsSupport: true,
      enableDnsHostnames: true,
      tags: [{ key: 'Name', value: `${p}-VPC` }],
    });

    // --- Internet Gateway ---
    const igw = new ec2.CfnInternetGateway(this, 'InternetGateway', {
      tags: [{ key: 'Name', value: `${p}-IGW` }],
    });

    // VPC에 IGW 연결
    const vpcGwAttachment = new ec2.CfnVPCGatewayAttachment(this, 'VPCGatewayAttachment', {
      vpcId: this.vpc.ref,
      internetGatewayId: igw.ref,
    });

    // --- 퍼블릭 서브넷 ---
    this.publicSubnet = new ec2.CfnSubnet(this, 'PublicSubnet', {
      vpcId: this.vpc.ref,
      cidrBlock: publicSubnetCidr,
      availabilityZone: selectedAZ,
      mapPublicIpOnLaunch: true,
      tags: [{ key: 'Name', value: `${p}-Public-Subnet` }],
    });

    // 퍼블릭 라우트 테이블
    const publicRouteTable = new ec2.CfnRouteTable(this, 'PublicRouteTable', {
      vpcId: this.vpc.ref,
      tags: [{ key: 'Name', value: `${p}-Public-RT` }],
    });

    // 퍼블릭 라우트: 0.0.0.0/0 → IGW
    // VPCGatewayAttachment 완료 후에 생성 (타이밍 문제 방지)
    const publicRoute = new ec2.CfnRoute(this, 'PublicRoute', {
      routeTableId: publicRouteTable.ref,
      destinationCidrBlock: '0.0.0.0/0',
      gatewayId: igw.ref,
    });
    (publicRoute as cdk.CfnResource).addDependency(vpcGwAttachment);

    // 퍼블릭 서브넷 ↔ 라우트 테이블 연결
    new ec2.CfnSubnetRouteTableAssociation(this, 'PublicSubnetRTAssociation', {
      subnetId: this.publicSubnet.ref,
      routeTableId: publicRouteTable.ref,
    });

    // --- 프라이빗 서브넷 ---
    this.privateSubnet = new ec2.CfnSubnet(this, 'PrivateSubnet', {
      vpcId: this.vpc.ref,
      cidrBlock: privateSubnetCidr,
      availabilityZone: selectedAZ,
      tags: [{ key: 'Name', value: `${p}-Private-Subnet` }],
    });

    // NAT Gateway용 Elastic IP
    const natEip = new ec2.CfnEIP(this, 'NatEIP', {
      domain: 'vpc',
      tags: [{ key: 'Name', value: `${p}-NAT-EIP` }],
    });

    // NAT Gateway (퍼블릭 서브넷에 배치)
    const natGateway = new ec2.CfnNatGateway(this, 'NatGateway', {
      subnetId: this.publicSubnet.ref,
      allocationId: natEip.attrAllocationId,
      tags: [{ key: 'Name', value: `${p}-NAT-GW` }],
    });

    // 프라이빗 라우트 테이블
    const privateRouteTable = new ec2.CfnRouteTable(this, 'PrivateRouteTable', {
      vpcId: this.vpc.ref,
      tags: [{ key: 'Name', value: `${p}-Private-RT` }],
    });

    // 프라이빗 라우트: 0.0.0.0/0 → NAT Gateway
    new ec2.CfnRoute(this, 'PrivateRoute', {
      routeTableId: privateRouteTable.ref,
      destinationCidrBlock: '0.0.0.0/0',
      natGatewayId: natGateway.ref,
    });

    // 프라이빗 서브넷 ↔ 라우트 테이블 연결
    new ec2.CfnSubnetRouteTableAssociation(this, 'PrivateSubnetRTAssociation', {
      subnetId: this.privateSubnet.ref,
      routeTableId: privateRouteTable.ref,
    });

    // --- S3 VPC Endpoint (Gateway 타입) ---
    new ec2.CfnVPCEndpoint(this, 'S3VPCEndpoint', {
      vpcId: this.vpc.ref,
      serviceName: `com.amazonaws.${cdk.Aws.REGION}.s3`,
      vpcEndpointType: 'Gateway',
      routeTableIds: [privateRouteTable.ref],
    });

    // --- VPC Flow Log → CloudWatch Logs ---
    // Flow Log용 로그 그룹 (보존 기간: 1일)
    // logGroupName을 지정하지 않으면 CDK가 고유 이름을 자동 생성하여 스택 간 충돌 방지
    this.logGroup = new logs.CfnLogGroup(this, 'FlowLogGroup', {
      retentionInDays: 1,
      tags: [{ key: 'Name', value: `${p}-FlowLog-Group` }],
    });

    // Flow Log용 IAM 역할
    const flowLogRole = new iam.CfnRole(this, 'FlowLogRole', {
      assumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { Service: 'vpc-flow-logs.amazonaws.com' },
            Action: 'sts:AssumeRole',
          },
        ],
      },
      policies: [
        {
          policyName: 'FlowLogPolicy',
          policyDocument: {
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Action: [
                  'logs:CreateLogGroup',
                  'logs:CreateLogStream',
                  'logs:PutLogEvents',
                  'logs:DescribeLogGroups',
                  'logs:DescribeLogStreams',
                ],
                Resource: '*',
              },
            ],
          },
        },
      ],
      tags: [{ key: 'Name', value: `${p}-FlowLog-Role` }],
    });

    // VPC Flow Log
    new ec2.CfnFlowLog(this, 'VPCFlowLog', {
      resourceId: this.vpc.ref,
      resourceType: 'VPC',
      trafficType: 'ALL',
      logDestinationType: 'cloud-watch-logs',
      logGroupName: this.logGroup.ref,
      deliverLogsPermissionArn: flowLogRole.attrArn,
      tags: [{ key: 'Name', value: `${p}-VPC-FlowLog` }],
    });

    // --- DCV용 보안 그룹 ---
    // SSH(22), DCV HTTP(8080), DCV HTTPS(8443) 인바운드 허용
    // 아웃바운드 전체 허용
    this.dcvSecurityGroup = new ec2.CfnSecurityGroup(this, 'DcvSecurityGroup', {
      groupDescription: 'Security group for DCV Instance - SSH, DCV HTTP/HTTPS',
      vpcId: this.vpc.ref,
      securityGroupIngress: [
        {
          ipProtocol: 'tcp',
          fromPort: 22,
          toPort: 22,
          cidrIp: props.allowedCidr,
          description: 'SSH access',
        },
        {
          ipProtocol: 'tcp',
          fromPort: 8080,
          toPort: 8080,
          cidrIp: props.allowedCidr,
          description: 'DCV HTTP',
        },
        {
          ipProtocol: 'tcp',
          fromPort: 8443,
          toPort: 8443,
          cidrIp: props.allowedCidr,
          description: 'DCV HTTPS',
        },
        // GR00T 활성화 시 ZMQ + ROS2 DDS 포트 추가
        ...(props.enableGroot ? [
          {
            ipProtocol: 'tcp',
            fromPort: 5555,
            toPort: 5555,
            cidrIp: props.allowedCidr,
            description: 'GR00T ZMQ inference server',
          },
          {
            ipProtocol: 'udp',
            fromPort: 7400,
            toPort: 7500,
            cidrIp: vpcCidr,
            description: 'ROS2 DDS Fast-DDS',
          },
        ] : []),
      ],
      securityGroupEgress: [
        {
          ipProtocol: '-1',
          cidrIp: '0.0.0.0/0',
          description: 'Allow all outbound traffic',
        },
      ],
      tags: [{ key: 'Name', value: `${p}-SG` }],
    });

    // --- code-server 8888 포트: CloudFront origin-facing prefix list로 제한 ---
    // prefix list ID는 리전마다 다르므로 AwsCustomResource로 동적 조회
    if (props.enableCodeServer ?? true) {
      const cfPrefixList = new cr.AwsCustomResource(this, 'CloudFrontPrefixListLookup', {
        onCreate: {
          service: 'EC2',
          action: 'describeManagedPrefixLists',
          parameters: {
            Filters: [{ Name: 'prefix-list-name', Values: ['com.amazonaws.global.cloudfront.origin-facing'] }],
          },
          physicalResourceId: cr.PhysicalResourceId.of('cf-prefix-list'),
        },
        installLatestAwsSdk: false,
        policy: cr.AwsCustomResourcePolicy.fromSdkCalls({ resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE }),
      });

      new ec2.CfnSecurityGroupIngress(this, 'CodeServerFromCloudFront', {
        groupId: this.dcvSecurityGroup.ref,
        ipProtocol: 'tcp',
        fromPort: 8888,
        toPort: 8888,
        sourcePrefixListId: cfPrefixList.getResponseField('PrefixLists.0.PrefixListId'),
        description: 'code-server via CloudFront only',
      });
    }
  }
}
