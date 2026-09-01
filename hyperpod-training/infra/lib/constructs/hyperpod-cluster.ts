import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as fsx from 'aws-cdk-lib/aws-fsx';
import { Construct } from 'constructs';
import { InstanceGroupConfig } from '../config/cluster-config';

export interface HyperPodClusterProps {
  namePrefix: string;
  vpcId: string;
  privateSubnetId: string;
  /** 클러스터 전용 FSx를 만든 경우의 SG. 공유 FSx import 시에는 원 소유 스택
   *  SG가 VPC CIDR 인바운드를 이미 허용하므로 생략한다(ingress 규칙 스킵). */
  fsxSecurityGroup?: ec2.CfnSecurityGroup;
  /** Lustre DNS/mount name — lifecycle bucket에 fsx.env로 스테이징되어
   *  setup_fsx.sh가 올바른 파일시스템을 마운트하게 한다. */
  fsxDnsName: string;
  fsxMountName: string;
  dataBucket: s3.CfnBucket;
  endpointSG?: ec2.CfnSecurityGroup;
  ssmEndpoints?: ec2.CfnVPCEndpoint[];
  head: InstanceGroupConfig;
  gpu: InstanceGroupConfig[];
  debug: InstanceGroupConfig;
  /** AMI 보안 패치 cron. 비우면 패치가 수동 작업으로 남는다. */
  amiUpdateSchedule?: string;
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
      tags: [{ key: 'Name', value: `${p}-Cluster-Role` }],
    });

    this.lifecycleBucket = new s3.CfnBucket(this, 'LifecycleBucket', {
      // storage.ts의 DataBucket과 같은 이유로 namePrefix를 빼고 계정 ID+리전만 사용
      // (기존 hyperpod-lifecycle-hyperpod-<acct>-<acct>-<region>은 68자로 63자 제한 초과).
      bucketName: cdk.Fn.join('-', ['hyperpod-lifecycle', cdk.Aws.ACCOUNT_ID, cdk.Aws.REGION]),
      tags: [{ key: 'Name', value: `${p}-Lifecycle-Bucket` }],
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

    if (props.fsxSecurityGroup) {
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
    }

    // Upload lifecycle scripts to S3 (include bucket.conf for self-discovery).
    //
    // fsx.env names the filesystem belonging to THIS cluster. setup_fsx.sh reads it
    // instead of guessing: its fallback (`describe-file-systems ... | [0]`) returns
    // the first Lustre FS in the region, which in an account with several FSx
    // filesystems is often another VPC's — the mount then fails and, since
    // on_create.sh treats that as non-fatal, the cluster comes up with no /fsx.
    // IMDS cannot help here either: HyperPod nodes run in a SageMaker-owned account
    // and report the service VPC, not the cluster VPC.
    const lifecycleScriptsPath = path.join(__dirname, '..', '..', '..', 'lifecycle-scripts');
    const lifecycleDeploy = new s3deploy.BucketDeployment(this, 'LifecycleScriptsDeploy', {
      sources: [
        s3deploy.Source.asset(lifecycleScriptsPath),
        s3deploy.Source.data('bucket.conf', this.lifecycleBucket.ref),
        s3deploy.Source.data(
          'fsx.env',
          `FSX_DNS_NAME=${props.fsxDnsName}\nFSX_MOUNT_NAME=${props.fsxMountName}\n`,
        ),
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
      // 보안 패치를 예약 실행으로 넘겨 수동 UpdateClusterSoftware 호출을 없앤다.
      // Slurm은 DeploymentConfig(배치 교체/자동 롤백)를 못 쓰므로 ScheduleExpression만 지정한다.
      ...(props.amiUpdateSchedule
        ? { ScheduledUpdateConfig: { ScheduleExpression: props.amiUpdateSchedule } }
        : {}),
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
        Tags: [{ Key: 'Name', Value: `${p}-Cluster` }],
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
