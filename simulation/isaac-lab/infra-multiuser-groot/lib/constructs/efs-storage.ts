/**
 * EfsStorageConstruct
 *
 * EFS 파일 시스템, 보안 그룹, Mount Target을 생성하는 L1 Construct.
 * DCV Instance와 Batch 환경 간 데이터 공유를 위한 공유 스토리지를 제공한다.
 *
 * L1 Construct(Cfn* 클래스)를 사용하여 원본 CloudFormation 템플릿과
 * 1:1 대응을 유지하고, CDK synth 결과를 예측 가능하게 한다.
 */
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as efs from 'aws-cdk-lib/aws-efs';
import { Construct } from 'constructs';

/**
 * EfsStorageConstruct Props
 */
export interface EfsStorageProps {
  /** VPC 참조 */
  vpc: ec2.CfnVPC;
  /** 프라이빗 서브넷 참조 */
  privateSubnet: ec2.CfnSubnet;
  /** VPC CIDR (EFS SG 인바운드 소스, 기본값: '10.0.0.0/16') */
  vpcCidr?: string;
}

/**
 * EFS 스토리지 인프라를 구성하는 Construct
 *
 * 생성 리소스:
 * - EFS 파일 시스템 (generalPurpose 성능 모드)
 * - EFS 보안 그룹 (NFS:2049 인바운드, 소스: VPC CIDR 10.0.0.0/16)
 * - EFS Mount Target (프라이빗 서브넷)
 */
export class EfsStorageConstruct extends Construct {
  /** EFS 파일 시스템 */
  public readonly fileSystem: efs.CfnFileSystem;
  /** EFS 보안 그룹 */
  public readonly securityGroup: ec2.CfnSecurityGroup;

  constructor(scope: Construct, id: string, props: EfsStorageProps) {
    super(scope, id);

    // --- EFS 파일 시스템 ---
    // generalPurpose 성능 모드로 생성
    this.fileSystem = new efs.CfnFileSystem(this, 'FileSystem', {
      performanceMode: 'generalPurpose',
      fileSystemTags: [{ key: 'Name', value: 'IsaacLab-EFS' }],
    });

    // --- EFS 보안 그룹 ---
    // NFS(2049) 인바운드, 소스: VPC CIDR (10.0.0.0/16)
    // 아웃바운드 전체 허용
    this.securityGroup = new ec2.CfnSecurityGroup(this, 'EfsSecurityGroup', {
      groupDescription: 'Security group for EFS - NFS(2049) inbound',
      vpcId: props.vpc.ref,
      securityGroupIngress: [
        {
          ipProtocol: 'tcp',
          fromPort: 2049,
          toPort: 2049,
          cidrIp: props.vpcCidr ?? '10.0.0.0/16',
          description: 'NFS access from VPC CIDR',
        },
      ],
      securityGroupEgress: [
        {
          ipProtocol: '-1',
          cidrIp: '0.0.0.0/0',
          description: 'Allow all outbound traffic',
        },
      ],
      tags: [{ key: 'Name', value: 'IsaacLab-EFS-SG' }],
    });

    // --- EFS Mount Target ---
    // 프라이빗 서브넷에 생성, EFS 보안 그룹 연결
    new efs.CfnMountTarget(this, 'MountTarget', {
      fileSystemId: this.fileSystem.ref,
      subnetId: props.privateSubnet.ref,
      securityGroups: [this.securityGroup.ref],
    });
  }
}
