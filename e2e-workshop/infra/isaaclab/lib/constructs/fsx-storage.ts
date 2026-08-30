/**
 * FsxStorageConstruct
 *
 * 워크숍 공유 FSx for Lustre 파일시스템.
 *
 * 이 파일시스템 하나를 세 곳이 공유한다:
 *   - DCV 인스턴스: fsx-mount.sh가 /fsx 에 마운트 (체크포인트를 바로 실험)
 *   - SageMaker Training: groot per-user 스택이 아티팩트 버킷과 DRA를 걸어
 *     학습 잡의 S3 export가 /fsx/groot/... 에 자동 반영
 *   - HyperPod 클러스터: -c createVpc=false -c fsxFileSystemId=... 로 배포하면
 *     자체 FSx를 만들지 않고 이 파일시스템을 /fsx 에 마운트
 *
 * DRA(DataRepositoryAssociation)를 여러 개 걸어야 하므로 PERSISTENT_2 로 생성한다
 * (SCRATCH 배포 타입은 DRA를 지원하지 않는다).
 */
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as fsx from 'aws-cdk-lib/aws-fsx';
import { Construct } from 'constructs';

export interface FsxStorageProps {
  /** 리소스 Name 태그 접두사 (예: 'IsaacLab-Latest-alice') */
  namePrefix: string;
  /** VPC 참조 */
  vpc: ec2.CfnVPC;
  /** 프라이빗 서브넷 참조 (FSx ENI 위치 — 같은 VPC면 퍼블릭 서브넷의 DCV도 접근 가능) */
  privateSubnet: ec2.CfnSubnet;
  /** VPC CIDR (Lustre 포트 인바운드 소스, 기본값: '10.0.0.0/16') */
  vpcCidr?: string;
  /** 스토리지 용량 GiB (PERSISTENT_2는 1200 단위, 기본값: 1200) */
  capacityGiB?: number;
}

export class FsxStorageConstruct extends Construct {
  /** FSx for Lustre 파일시스템 */
  public readonly fileSystem: fsx.CfnFileSystem;
  /** FSx 보안 그룹 (Lustre 988, 1018-1023 인바운드) */
  public readonly securityGroup: ec2.CfnSecurityGroup;

  constructor(scope: Construct, id: string, props: FsxStorageProps) {
    super(scope, id);

    const p = props.namePrefix;
    const cidr = props.vpcCidr ?? '10.0.0.0/16';

    // VPC CIDR 전체에서 인바운드를 허용해 두면, 같은 VPC에 나중에 합류하는
    // HyperPod 노드(별도 SG)도 SG 수정 없이 바로 마운트할 수 있다.
    this.securityGroup = new ec2.CfnSecurityGroup(this, 'FsxSecurityGroup', {
      groupDescription: 'Security group for FSx Lustre - 988/1018-1023 inbound',
      vpcId: props.vpc.ref,
      securityGroupIngress: [
        {
          ipProtocol: 'tcp',
          fromPort: 988,
          toPort: 988,
          cidrIp: cidr,
          description: 'Lustre from VPC CIDR',
        },
        {
          ipProtocol: 'tcp',
          fromPort: 1018,
          toPort: 1023,
          cidrIp: cidr,
          description: 'Lustre from VPC CIDR',
        },
      ],
      securityGroupEgress: [
        {
          ipProtocol: '-1',
          cidrIp: '0.0.0.0/0',
          description: 'Allow all outbound traffic',
        },
      ],
      tags: [{ key: 'Name', value: `${p}-FSx-SG` }],
    });

    this.fileSystem = new fsx.CfnFileSystem(this, 'LustreFileSystem', {
      fileSystemType: 'LUSTRE',
      storageCapacity: props.capacityGiB ?? 1200,
      subnetIds: [props.privateSubnet.ref],
      securityGroupIds: [this.securityGroup.ref],
      lustreConfiguration: {
        deploymentType: 'PERSISTENT_2',
        perUnitStorageThroughput: 125,
        dataCompressionType: 'LZ4',
      },
      tags: [{ key: 'Name', value: `${p}-FSx` }],
    });
  }
}
