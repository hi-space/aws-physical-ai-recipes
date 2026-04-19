/**
 * BatchInfraConstruct
 *
 * AWS Batch에서 사용할 Launch Template, IAM 역할, Instance Profile,
 * 보안 그룹을 생성하는 L1 Construct.
 *
 * Batch Compute Environment, Job Queue, Job Definition은 자동화 범위 밖이며,
 * 사용자가 AWS 콘솔에서 CfnOutput을 참조하여 수동 생성한다.
 *
 * L1 Construct(Cfn* 클래스)를 사용하여 원본 CloudFormation 템플릿과
 * 1:1 대응을 유지하고, CDK synth 결과를 예측 가능하게 한다.
 */
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

/**
 * BatchInfraConstruct Props
 */
export interface BatchInfraProps {
  /** 리소스 Name 태그 접두사 (예: 'IsaacLab-Stable-alice') */
  namePrefix: string;
  /** VPC 참조 */
  vpc: ec2.CfnVPC;
  /** 프라이빗 서브넷 참조 */
  privateSubnet: ec2.CfnSubnet;
  /** EFS 보안 그룹 참조 */
  efsSecurityGroup: ec2.CfnSecurityGroup;
  /** Batch용 ECS Optimized AMI ID */
  batchAmiId: string;
}

/**
 * Batch 인프라를 구성하는 Construct
 *
 * 생성 리소스:
 * - IAM Role (S3 읽기, ECS 컨테이너 서비스, EFS 전체, SSM)
 * - IAM Instance Profile
 * - Batch용 보안 그룹 (아웃바운드 전체 허용)
 * - EFS SG에 Batch SG를 소스로 하는 NFS(2049) 인그레스 규칙
 * - EC2 Launch Template (ECS Optimized AMI, 250GB EBS gp3)
 */
export class BatchInfraConstruct extends Construct {
  /** Batch용 EC2 Launch Template */
  public readonly launchTemplate: ec2.CfnLaunchTemplate;
  /** Instance Profile ARN */
  public readonly instanceProfileArn: string;
  /** Batch용 보안 그룹 */
  public readonly securityGroup: ec2.CfnSecurityGroup;

  constructor(scope: Construct, id: string, props: BatchInfraProps) {
    super(scope, id);

    const p = props.namePrefix;

    // --- IAM Role ---
    // Batch EC2 인스턴스용 역할: S3 읽기, ECS 컨테이너 서비스, EFS 전체, SSM
    const role = new iam.CfnRole(this, 'BatchRole', {
      assumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { Service: 'ec2.amazonaws.com' },
            Action: 'sts:AssumeRole',
          },
        ],
      },
      managedPolicyArns: [
        'arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess',
        'arn:aws:iam::aws:policy/service-role/AmazonEC2ContainerServiceforEC2Role',
        'arn:aws:iam::aws:policy/AmazonElasticFileSystemFullAccess',
        'arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore',
      ],
      tags: [{ key: 'Name', value: `${p}-Batch-Role` }],
    });

    // --- Instance Profile ---
    const instanceProfile = new iam.CfnInstanceProfile(this, 'BatchInstanceProfile', {
      roles: [role.ref],
    });
    this.instanceProfileArn = instanceProfile.attrArn;

    // --- Batch용 보안 그룹 ---
    // 아웃바운드 전체 허용 (인그레스는 EFS SG 쪽에서 설정)
    const batchSecurityGroup = new ec2.CfnSecurityGroup(this, 'BatchSecurityGroup', {
      groupDescription: 'Security group for Batch - EFS NFS(2049) access',
      vpcId: props.vpc.ref,
      securityGroupEgress: [
        {
          ipProtocol: '-1',
          cidrIp: '0.0.0.0/0',
          description: 'Allow all outbound traffic',
        },
      ],
      tags: [{ key: 'Name', value: `${p}-Batch-SG` }],
    });
    this.securityGroup = batchSecurityGroup;

    // --- Batch SG 자기 참조 인그레스: 분산 학습 노드 간 통신 허용 ---
    // PyTorch distributed rendezvous (port 5555) 및 NCCL 통신에 필요.
    // 이 규칙이 없으면 RendezvousTimeoutError 발생.
    new ec2.CfnSecurityGroupIngress(this, 'BatchSelfIngress', {
      groupId: batchSecurityGroup.ref,
      ipProtocol: '-1',
      sourceSecurityGroupId: batchSecurityGroup.ref,
      description: 'Inter-node communication for distributed training',
    });

    // --- EFS SG에 Batch SG를 소스로 하는 NFS(2049) 인그레스 규칙 추가 ---
    // Batch 인스턴스 → EFS 접근을 위해 EFS SG에 인그레스 규칙 설정 (순환 참조 방지를 위해 별도 리소스)
    new ec2.CfnSecurityGroupIngress(this, 'EfsFromBatchIngress', {
      groupId: props.efsSecurityGroup.ref,
      ipProtocol: 'tcp',
      fromPort: 2049,
      toPort: 2049,
      sourceSecurityGroupId: batchSecurityGroup.ref,
    });

    // --- EC2 Launch Template ---
    // Batch Compute Environment에서 사용할 Launch Template
    // ECS Optimized AMI, 250GB EBS gp3
    this.launchTemplate = new ec2.CfnLaunchTemplate(this, 'BatchLaunchTemplate', {
      launchTemplateData: {
        imageId: props.batchAmiId,
        blockDeviceMappings: [
          {
            deviceName: '/dev/xvda',
            ebs: {
              volumeSize: 250,
              volumeType: 'gp3',
              encrypted: true,
              deleteOnTermination: true,
            },
          },
        ],
      },
      tagSpecifications: [
        {
          resourceType: 'launch-template',
          tags: [{ key: 'Name', value: `${p}-Batch-LT` }],
        },
      ],
    });
  }
}
