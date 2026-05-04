import * as cdk from 'aws-cdk-lib';
import * as batch from 'aws-cdk-lib/aws-batch';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface BatchComputeEnvProps {
  namePrefix: string;
  vpc: ec2.IVpc;
  privateSubnet: ec2.ISubnet;
  efsSecurityGroup: ec2.ISecurityGroup;
}

export class BatchComputeEnv extends Construct {
  public readonly computeEnvironment: batch.ManagedEc2EcsComputeEnvironment;
  public readonly securityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: BatchComputeEnvProps) {
    super(scope, id);

    const stack = cdk.Stack.of(this);

    // Security group for Batch instances
    this.securityGroup = new ec2.SecurityGroup(this, 'BatchSg', {
      vpc: props.vpc,
      description: 'Security group for GR00T fine-tuning Batch instances',
      allowAllOutbound: true,
    });

    // Self-reference for multi-GPU distributed training (NCCL)
    this.securityGroup.addIngressRule(
      this.securityGroup,
      ec2.Port.allTraffic(),
      'Allow inter-node communication for distributed training',
    );

    // NFS access to shared EFS
    this.securityGroup.addIngressRule(
      props.efsSecurityGroup,
      ec2.Port.tcp(2049),
      'Allow NFS from EFS',
    );

    // Allow Batch SG to access EFS
    props.efsSecurityGroup.addIngressRule(
      this.securityGroup,
      ec2.Port.tcp(2049),
      'Allow NFS from Batch instances',
    );

    // Instance role
    const instanceRole = new iam.Role(this, 'InstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonS3ReadOnlyAccess'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonEC2ContainerServiceforEC2Role'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonElasticFileSystemFullAccess'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    // Launch template with large root volume for Docker images
    const launchTemplate = new ec2.LaunchTemplate(this, 'LaunchTemplate', {
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: ec2.BlockDeviceVolume.ebs(250, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            encrypted: true,
          }),
        },
      ],
    });

    this.computeEnvironment = new batch.ManagedEc2EcsComputeEnvironment(this, 'ComputeEnv', {
      computeEnvironmentName: `${props.namePrefix}-GrootFinetune`,
      vpc: props.vpc,
      vpcSubnets: { subnets: [props.privateSubnet] },
      securityGroups: [this.securityGroup],
      instanceRole,
      instanceTypes: [
        ec2.InstanceType.of(ec2.InstanceClass.G6E, ec2.InstanceSize.XLARGE2),
        ec2.InstanceType.of(ec2.InstanceClass.G6E, ec2.InstanceSize.XLARGE4),
        ec2.InstanceType.of(ec2.InstanceClass.G6E, ec2.InstanceSize.XLARGE8),
        ec2.InstanceType.of(ec2.InstanceClass.G6E, ec2.InstanceSize.XLARGE12),
        ec2.InstanceType.of(ec2.InstanceClass.G6E, ec2.InstanceSize.XLARGE48),
      ],
      minvCpus: 0,
      maxvCpus: 192,
      launchTemplate,
    });
  }
}
