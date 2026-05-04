import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as efs from 'aws-cdk-lib/aws-efs';
import { Construct } from 'constructs';

export interface SharedResourceImporterProps {
  vpcId: string;
  efsFileSystemId: string;
  efsSecurityGroupId: string;
  privateSubnetId: string;
  availabilityZone: string;
}

export class SharedResourceImporter extends Construct {
  public readonly vpc: ec2.IVpc;
  public readonly efsFileSystem: efs.IFileSystem;
  public readonly efsSecurityGroup: ec2.ISecurityGroup;
  public readonly privateSubnet: ec2.ISubnet;

  constructor(scope: Construct, id: string, props: SharedResourceImporterProps) {
    super(scope, id);

    // Use fromVpcAttributes to avoid runtime lookups during synth
    this.vpc = ec2.Vpc.fromVpcAttributes(this, 'Vpc', {
      vpcId: props.vpcId,
      availabilityZones: [props.availabilityZone],
      privateSubnetIds: [props.privateSubnetId],
    });

    this.efsSecurityGroup = ec2.SecurityGroup.fromSecurityGroupId(
      this, 'EfsSg', props.efsSecurityGroupId,
    );

    this.efsFileSystem = efs.FileSystem.fromFileSystemAttributes(this, 'Efs', {
      fileSystemId: props.efsFileSystemId,
      securityGroup: this.efsSecurityGroup,
    });

    this.privateSubnet = ec2.Subnet.fromSubnetAttributes(this, 'PrivateSubnet', {
      subnetId: props.privateSubnetId,
      availabilityZone: props.availabilityZone,
    });
  }
}
