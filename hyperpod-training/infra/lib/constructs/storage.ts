import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as fsx from 'aws-cdk-lib/aws-fsx';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

export interface StorageProps {
  namePrefix: string;
  vpcId: string;
  privateSubnetId: string;
  fsxCapacityGiB: number;
  /**
   * 기존 FSx for Lustre 재사용 (isaaclab 스택의 공유 FSx). 지정하면 클러스터
   * 전용 FSx를 만들지 않고 DRA만 이 파일시스템에 추가한다. Lustre는 같은
   * VPC에서만 마운트되므로 createVpc=false와 함께 써야 한다.
   */
  importedFsxId?: string;
  /** 재사용할 FSx의 Lustre mount name (`aws fsx describe-file-systems`로 확인). */
  importedFsxMountName?: string;
}

export class StorageConstruct extends Construct {
  public readonly bucket: s3.CfnBucket;
  /** FSx 파일시스템 ID (생성 또는 import) */
  public readonly fileSystemId: string;
  /** Lustre 마운트에 쓰는 DNS 이름 */
  public readonly fsxDnsName: string;
  /** Lustre mount name */
  public readonly fsxMountName: string;
  /** 클러스터 전용 FSx를 만들었을 때만 존재. import 시에는 원 소유 스택의
   *  SG가 VPC CIDR 인바운드를 이미 허용하므로 여기서 SG를 만들지 않는다. */
  public readonly securityGroup?: ec2.CfnSecurityGroup;

  constructor(scope: Construct, id: string, props: StorageProps) {
    super(scope, id);
    const p = props.namePrefix;

    this.bucket = new s3.CfnBucket(this, 'DataBucket', {
      // namePrefix(hyperpod-<ACCOUNT_ID>)를 그대로 붙이면 'hyperpod'와 계정 ID가
      // 중복되어 리전명이 긴 리전(ap-northeast-1 등)에서 S3 63자 제한을 초과한다.
      bucketName: cdk.Fn.join('-', ['hyperpod-data', cdk.Aws.ACCOUNT_ID, cdk.Aws.REGION]),
      versioningConfiguration: { status: 'Enabled' },
      lifecycleConfiguration: {
        rules: [{ id: 'TransitionToIA', status: 'Enabled', transitions: [{ storageClass: 'INTELLIGENT_TIERING', transitionInDays: 30 }] }],
      },
      tags: [{ key: 'Name', value: `${p}-Data-Bucket` }],
    });

    if (props.importedFsxId) {
      // 공유 FSx 재사용: 파일시스템/SG를 만들지 않고 식별자만 노출한다.
      this.fileSystemId = props.importedFsxId;
      this.fsxDnsName = `${props.importedFsxId}.fsx.${cdk.Aws.REGION}.amazonaws.com`;
      this.fsxMountName = props.importedFsxMountName!;
    } else {
      this.securityGroup = new ec2.CfnSecurityGroup(this, 'FsxSG', {
        groupDescription: 'FSx for Lustre security group',
        vpcId: props.vpcId,
        securityGroupIngress: [
          { ipProtocol: 'tcp', fromPort: 988, toPort: 988, cidrIp: '10.0.0.0/16', description: 'Lustre' },
          { ipProtocol: 'tcp', fromPort: 1021, toPort: 1023, cidrIp: '10.0.0.0/16', description: 'Lustre' },
        ],
        securityGroupEgress: [{ ipProtocol: '-1', cidrIp: '0.0.0.0/0' }],
        tags: [{ key: 'Name', value: `${p}-FSx-SG` }],
      });

      // PERSISTENT_2 does not support importPath/exportPath inline.
      // Must use separate DataRepositoryAssociation resources.
      const fileSystem = new fsx.CfnFileSystem(this, 'LustreFS', {
        fileSystemType: 'LUSTRE',
        storageCapacity: props.fsxCapacityGiB,
        subnetIds: [props.privateSubnetId],
        securityGroupIds: [this.securityGroup.ref],
        lustreConfiguration: {
          deploymentType: 'PERSISTENT_2',
          perUnitStorageThroughput: 125,
          dataCompressionType: 'LZ4',
        },
        tags: [{ key: 'Name', value: `${p}-FSx` }],
      });
      this.fileSystemId = fileSystem.ref;
      this.fsxDnsName = fileSystem.attrDnsName;
      this.fsxMountName = fileSystem.attrLustreMountName;
    }

    // datasets/ → auto-import from S3
    new fsx.CfnDataRepositoryAssociation(this, 'DRADatasets', {
      fileSystemId: this.fileSystemId,
      fileSystemPath: '/datasets',
      dataRepositoryPath: cdk.Fn.join('', ['s3://', this.bucket.ref, '/datasets']),
      s3: {
        autoImportPolicy: { events: ['NEW', 'CHANGED', 'DELETED'] },
      },
      tags: [{ key: 'Name', value: `${p}-DRA-Datasets` }],
    });

    // checkpoints/ → auto-export to S3
    new fsx.CfnDataRepositoryAssociation(this, 'DRACheckpoints', {
      fileSystemId: this.fileSystemId,
      fileSystemPath: '/checkpoints',
      dataRepositoryPath: cdk.Fn.join('', ['s3://', this.bucket.ref, '/checkpoints']),
      s3: {
        autoExportPolicy: { events: ['NEW', 'CHANGED', 'DELETED'] },
      },
      tags: [{ key: 'Name', value: `${p}-DRA-Checkpoints` }],
    });

    // enroot/ → auto-import pre-built container images from S3
    new fsx.CfnDataRepositoryAssociation(this, 'DRAEnroot', {
      fileSystemId: this.fileSystemId,
      fileSystemPath: '/enroot',
      dataRepositoryPath: cdk.Fn.join('', ['s3://', this.bucket.ref, '/enroot']),
      s3: {
        autoImportPolicy: { events: ['NEW', 'CHANGED', 'DELETED'] },
      },
      tags: [{ key: 'Name', value: `${p}-DRA-Enroot` }],
    });
  }
}
