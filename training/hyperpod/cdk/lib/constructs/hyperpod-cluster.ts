import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';
import { InstanceGroupConfig } from '../config/cluster-config';

export interface HyperPodClusterProps {
  namePrefix: string;
  vpcId: string;
  privateSubnetId: string;
  fsxSecurityGroup: ec2.CfnSecurityGroup;
  dataBucket: s3.CfnBucket;
  endpointSG?: ec2.CfnSecurityGroup;
  ssmEndpoints?: ec2.CfnVPCEndpoint[];
  head: InstanceGroupConfig;
  gpu: InstanceGroupConfig[];
  debug: InstanceGroupConfig;
}

export class HyperPodClusterConstruct extends Construct {
  public readonly clusterName: string;
  public readonly executionRole: iam.CfnRole;
  public readonly lifecycleBucket: s3.CfnBucket;
  public readonly clusterSecurityGroupId: string;

  constructor(scope: Construct, id: string, props: HyperPodClusterProps) {
    super(scope, id);
    const p = props.namePrefix;

    this.executionRole = new iam.CfnRole(this, 'ExecutionRole', {
      assumeRolePolicyDocument: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: ['sagemaker.amazonaws.com', 'ssm.amazonaws.com'] }, Action: 'sts:AssumeRole' }] },
      managedPolicyArns: [
        'arn:aws:iam::aws:policy/AmazonSageMakerClusterInstanceRolePolicy',
        'arn:aws:iam::aws:policy/AmazonS3FullAccess',
        'arn:aws:iam::aws:policy/AmazonFSxFullAccess',
        'arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore',
      ],
      policies: [{
        policyName: 'HyperPodVpcAccess',
        policyDocument: {
          Version: '2012-10-17',
          Statement: [{
            Effect: 'Allow',
            Action: [
              'ec2:CreateNetworkInterface',
              'ec2:CreateNetworkInterfacePermission',
              'ec2:DeleteNetworkInterface',
              'ec2:DeleteNetworkInterfacePermission',
              'ec2:DescribeNetworkInterfaces',
              'ec2:DescribeVpcs',
              'ec2:DescribeSubnets',
              'ec2:DescribeSecurityGroups',
              'ec2:DescribeDhcpOptions',
            ],
            Resource: '*',
          }],
        },
      }, {
        policyName: 'MLflowAccess',
        policyDocument: {
          Version: '2012-10-17',
          Statement: [{
            Effect: 'Allow',
            Action: ['sagemaker-mlflow:*'],
            Resource: `arn:aws:sagemaker:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:mlflow-tracking-server/*`,
          }],
        },
      }, {
        policyName: 'ECRAccess',
        policyDocument: {
          Version: '2012-10-17',
          Statement: [{
            Effect: 'Allow',
            Action: [
              'ecr:GetAuthorizationToken',
              'ecr:BatchCheckLayerAvailability',
              'ecr:GetDownloadUrlForLayer',
              'ecr:BatchGetImage',
            ],
            Resource: '*',
          }],
        },
      }],
      tags: [{ key: 'Name', value: `${p}-HyperPod-Role` }],
    });

    this.lifecycleBucket = new s3.CfnBucket(this, 'LifecycleBucket', {
      bucketName: cdk.Fn.join('-', ['hyperpod-lifecycle', p.toLowerCase(), cdk.Aws.ACCOUNT_ID, cdk.Aws.REGION]),
      tags: [{ key: 'Name', value: `${p}-Lifecycle` }],
    });
    this.lifecycleBucket.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    const clusterSG = new ec2.CfnSecurityGroup(this, 'ClusterSG', {
      groupDescription: 'HyperPod cluster internal communication',
      vpcId: props.vpcId,
      securityGroupEgress: [{ ipProtocol: '-1', cidrIp: '0.0.0.0/0' }],
      tags: [{ key: 'Name', value: `${p}-Cluster-SG` }],
    });
    this.clusterSecurityGroupId = clusterSG.ref;

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

    // Upload lifecycle scripts to S3 (include bucket.conf for self-discovery)
    const lifecycleScriptsPath = path.join(__dirname, '..', '..', '..', 'lifecycle-scripts');
    const lifecycleDeploy = new s3deploy.BucketDeployment(this, 'LifecycleScriptsDeploy', {
      sources: [
        s3deploy.Source.asset(lifecycleScriptsPath),
        s3deploy.Source.data('bucket.conf', this.lifecycleBucket.ref),
      ],
      destinationBucket: s3.Bucket.fromBucketName(this, 'LifecycleBucketRef', this.lifecycleBucket.ref),
      destinationKeyPrefix: 'lifecycle-scripts/',
    });

    const buildInstanceGroup = (config: InstanceGroupConfig) => ({
      InstanceGroupName: config.name,
      InstanceType: config.instanceType,
      InstanceCount: config.instanceCount,
      LifeCycleConfig: {
        SourceS3Uri: cdk.Fn.join('', ['s3://', this.lifecycleBucket.ref, '/lifecycle-scripts/']),
        OnCreate: 'on_create.sh',
      },
      ExecutionRole: this.executionRole.attrArn,
      SlurmConfig: {
        NodeType: config.slurmNodeType,
      },
    });

    this.clusterName = p.toLowerCase();

    const cluster = new cdk.CfnResource(this, 'Cluster', {
      type: 'AWS::SageMaker::Cluster',
      properties: {
        ClusterName: this.clusterName,
        Orchestrator: {
          Slurm: {
            SlurmConfigStrategy: 'Managed',
          },
        },
        InstanceGroups: [
          buildInstanceGroup(props.head),
          ...props.gpu.map(buildInstanceGroup),
          buildInstanceGroup(props.debug),
        ],
        VpcConfig: {
          SecurityGroupIds: [clusterSG.ref],
          Subnets: [props.privateSubnetId],
        },
        NodeRecovery: 'Automatic',
      },
    });
    // Ensure lifecycle scripts are uploaded and role is propagated before cluster creation
    cluster.addDependency(this.executionRole);
    cluster.node.addDependency(lifecycleDeploy);

    // Cluster must wait for SSM endpoints so nodes can register on boot
    if (props.ssmEndpoints) {
      for (const ep of props.ssmEndpoints) {
        cluster.addDependency(ep);
      }
    }

    // Allow cluster nodes to reach VPC endpoints (HTTPS 443)
    if (props.endpointSG) {
      new ec2.CfnSecurityGroupIngress(this, 'EndpointFromCluster', {
        groupId: props.endpointSG.ref,
        ipProtocol: 'tcp',
        fromPort: 443,
        toPort: 443,
        sourceSecurityGroupId: clusterSG.ref,
        description: 'HTTPS from HyperPod nodes to VPC endpoints',
      });
    }

    new cdk.CfnOutput(this, 'ClusterNameOutput', { value: this.clusterName, description: 'HyperPod Cluster Name' });
    new cdk.CfnOutput(this, 'LifecycleBucketOutput', { value: this.lifecycleBucket.ref, description: 'Lifecycle Scripts S3 Bucket' });
  }
}
