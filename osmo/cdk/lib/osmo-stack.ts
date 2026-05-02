import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { NetworkingConstruct } from './constructs/networking';
import { EksClusterConstruct } from './constructs/eks-cluster';
import { DataStoresConstruct } from './constructs/data-stores';
import { OsmoInstallConstruct } from './constructs/osmo-install';

export interface OsmoStackProps extends cdk.StackProps {
  userId?: string;
  vpcCidr?: string;
  gpuSimMaxNodes?: number;
  gpuTrainMaxNodes?: number;
}

export class OsmoStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: OsmoStackProps) {
    super(scope, id, props);

    const userId = props.userId ?? '';
    const userSuffix = userId ? `-${userId}` : '';
    const namePrefix = `Osmo${userSuffix}`;

    if (userId) {
      cdk.Tags.of(this).add('UserId', userId);
    }

    // 1. Networking
    const networking = new NetworkingConstruct(this, 'Networking', {
      namePrefix,
      vpcCidr: props.vpcCidr,
    });

    // 2. EKS Cluster
    const eksCluster = new EksClusterConstruct(this, 'EksCluster', {
      namePrefix,
      vpc: networking.vpc,
      privateSubnets: networking.privateSubnets,
      publicSubnets: networking.publicSubnets,
      gpuSimMaxNodes: props.gpuSimMaxNodes,
      gpuTrainMaxNodes: props.gpuTrainMaxNodes,
    });

    // 3. Data Stores
    const dataStores = new DataStoresConstruct(this, 'DataStores', {
      namePrefix,
      vpc: networking.vpc,
      privateSubnets: networking.privateSubnets,
      eksSecurityGroupId: eksCluster.cluster.clusterSecurityGroupId,
    });

    // 4. OSMO Install
    new OsmoInstallConstruct(this, 'OsmoInstall', {
      namePrefix,
      cluster: eksCluster.cluster,
      dbEndpoint: dataStores.dbEndpoint,
      dbPort: dataStores.dbPort,
      dbSecretArn: dataStores.dbSecret.ref,
      redisEndpoint: dataStores.redisEndpoint,
      redisPort: dataStores.redisPort,
      dataBucket: dataStores.bucket,
    });

    // Stack Outputs
    new cdk.CfnOutput(this, 'EksClusterName', {
      value: eksCluster.clusterName,
      description: 'EKS Cluster Name',
    });
    new cdk.CfnOutput(this, 'S3BucketName', {
      value: dataStores.bucket.ref,
      description: 'OSMO Data S3 Bucket',
    });
    new cdk.CfnOutput(this, 'VpcId', {
      value: networking.vpc.ref,
      description: 'VPC ID',
    });
  }
}
