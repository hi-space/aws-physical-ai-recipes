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
}

export class StorageConstruct extends Construct {
  public readonly bucket: s3.CfnBucket;
  public readonly fileSystem: fsx.CfnFileSystem;
  public readonly securityGroup: ec2.CfnSecurityGroup;

  constructor(scope: Construct, id: string, props: StorageProps) {
    super(scope, id);
    const p = props.namePrefix;

    this.bucket = new s3.CfnBucket(this, 'DataBucket', {
      bucketName: cdk.Fn.join('-', ['hyperpod-data', p.toLowerCase(), cdk.Aws.ACCOUNT_ID, cdk.Aws.REGION]),
      versioningConfiguration: { status: 'Enabled' },
      lifecycleConfiguration: {
        rules: [{ id: 'TransitionToIA', status: 'Enabled', transitions: [{ storageClass: 'INTELLIGENT_TIERING', transitionInDays: 30 }] }],
      },
      tags: [{ key: 'Name', value: `${p}-Data` }],
    });

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
    this.fileSystem = new fsx.CfnFileSystem(this, 'LustreFS', {
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

    // datasets/ → auto-import from S3
    new fsx.CfnDataRepositoryAssociation(this, 'DRADatasets', {
      fileSystemId: this.fileSystem.ref,
      fileSystemPath: '/datasets',
      dataRepositoryPath: cdk.Fn.join('', ['s3://', this.bucket.ref, '/datasets']),
      s3: {
        autoImportPolicy: { events: ['NEW', 'CHANGED', 'DELETED'] },
      },
      tags: [{ key: 'Name', value: `${p}-DRA-Datasets` }],
    });

    // checkpoints/ → auto-export to S3
    new fsx.CfnDataRepositoryAssociation(this, 'DRACheckpoints', {
      fileSystemId: this.fileSystem.ref,
      fileSystemPath: '/checkpoints',
      dataRepositoryPath: cdk.Fn.join('', ['s3://', this.bucket.ref, '/checkpoints']),
      s3: {
        autoExportPolicy: { events: ['NEW', 'CHANGED', 'DELETED'] },
      },
      tags: [{ key: 'Name', value: `${p}-DRA-Checkpoints` }],
    });
  }
}
