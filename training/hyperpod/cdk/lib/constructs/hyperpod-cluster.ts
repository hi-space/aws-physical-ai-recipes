import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { InstanceGroupConfig } from '../config/cluster-config';

export interface HyperPodClusterProps {
  namePrefix: string;
  vpcId: string;
  privateSubnetId: string;
  fsxSecurityGroup: ec2.CfnSecurityGroup;
  dataBucket: s3.CfnBucket;
  head: InstanceGroupConfig;
  sim: InstanceGroupConfig;
  train: InstanceGroupConfig;
  debug: InstanceGroupConfig;
}

export class HyperPodClusterConstruct extends Construct {
  public readonly clusterName: string;
  public readonly executionRole: iam.CfnRole;
  public readonly lifecycleBucket: s3.CfnBucket;

  constructor(scope: Construct, id: string, props: HyperPodClusterProps) {
    super(scope, id);
    const p = props.namePrefix;

    this.executionRole = new iam.CfnRole(this, 'ExecutionRole', {
      assumeRolePolicyDocument: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'sagemaker.amazonaws.com' }, Action: 'sts:AssumeRole' }] },
      managedPolicyArns: [
        'arn:aws:iam::aws:policy/AmazonSageMakerClusterInstanceRolePolicy',
        'arn:aws:iam::aws:policy/AmazonS3FullAccess',
        'arn:aws:iam::aws:policy/AmazonFSxFullAccess',
        'arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore',
      ],
      tags: [{ key: 'Name', value: `${p}-HyperPod-Role` }],
    });

    this.lifecycleBucket = new s3.CfnBucket(this, 'LifecycleBucket', {
      bucketName: cdk.Fn.join('-', ['hyperpod-lifecycle', p.toLowerCase(), cdk.Aws.ACCOUNT_ID, cdk.Aws.REGION]),
      tags: [{ key: 'Name', value: `${p}-Lifecycle` }],
    });

    const clusterSG = new ec2.CfnSecurityGroup(this, 'ClusterSG', {
      groupDescription: 'HyperPod cluster internal communication',
      vpcId: props.vpcId,
      securityGroupEgress: [{ ipProtocol: '-1', cidrIp: '0.0.0.0/0' }],
      tags: [{ key: 'Name', value: `${p}-Cluster-SG` }],
    });

    new ec2.CfnSecurityGroupIngress(this, 'ClusterSelfIngress', {
      groupId: clusterSG.ref,
      ipProtocol: '-1',
      sourceSecurityGroupId: clusterSG.ref,
      description: 'Inter-node communication (NCCL, Ray, SLURM)',
    });

    new ec2.CfnSecurityGroupIngress(this, 'FsxFromCluster', {
      groupId: props.fsxSecurityGroup.ref,
      ipProtocol: 'tcp',
      fromPort: 988,
      toPort: 988,
      sourceSecurityGroupId: clusterSG.ref,
      description: 'Lustre from HyperPod',
    });
    new ec2.CfnSecurityGroupIngress(this, 'FsxFromCluster2', {
      groupId: props.fsxSecurityGroup.ref,
      ipProtocol: 'tcp',
      fromPort: 1021,
      toPort: 1023,
      sourceSecurityGroupId: clusterSG.ref,
      description: 'Lustre from HyperPod',
    });

    const buildInstanceGroup = (config: InstanceGroupConfig) => ({
      InstanceGroupName: config.name,
      InstanceType: config.instanceType,
      InstanceCount: config.maxCount,
      LifeCycleConfig: {
        SourceS3Uri: cdk.Fn.join('', ['s3://', this.lifecycleBucket.ref, '/lifecycle-scripts/']),
        OnCreate: 'on_create.sh',
      },
      ExecutionRole: this.executionRole.attrArn,
    });

    this.clusterName = p.toLowerCase();

    new cdk.CfnResource(this, 'Cluster', {
      type: 'AWS::SageMaker::Cluster',
      properties: {
        ClusterName: this.clusterName,
        InstanceGroups: [
          buildInstanceGroup(props.head),
          buildInstanceGroup(props.sim),
          buildInstanceGroup(props.train),
          buildInstanceGroup(props.debug),
        ],
        VpcConfig: {
          SecurityGroupIds: [clusterSG.ref],
          Subnets: [props.privateSubnetId],
        },
      },
    });

    new cdk.CfnOutput(this, 'ClusterNameOutput', { value: this.clusterName, description: 'HyperPod Cluster Name' });
    new cdk.CfnOutput(this, 'LifecycleBucketOutput', { value: this.lifecycleBucket.ref, description: 'Lifecycle Scripts S3 Bucket' });
  }
}
