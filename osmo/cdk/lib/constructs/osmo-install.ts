import * as cdk from 'aws-cdk-lib';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface OsmoInstallProps {
  namePrefix: string;
  clusterName: string;
  secretsCsiAddon: eks.CfnAddon;
  dbEndpoint: string;
  dbPort: string;
  dbSecretArn: string;
  redisEndpoint: string;
  redisPort: string;
  dataBucket: s3.CfnBucket;
}

export class OsmoInstallConstruct extends Construct {
  constructor(scope: Construct, id: string, props: OsmoInstallProps) {
    super(scope, id);

    const p = props.namePrefix;

    // Outputs for post-deploy script (helm/kubectl)
    new cdk.CfnOutput(cdk.Stack.of(this), 'OsmoClusterName', {
      value: props.clusterName,
      description: 'EKS Cluster Name for kubectl/helm',
    });
    new cdk.CfnOutput(cdk.Stack.of(this), 'OsmoDbEndpoint', {
      value: props.dbEndpoint,
      description: 'RDS PostgreSQL endpoint',
    });
    new cdk.CfnOutput(cdk.Stack.of(this), 'OsmoDbPort', {
      value: props.dbPort,
      description: 'RDS PostgreSQL port',
    });
    new cdk.CfnOutput(cdk.Stack.of(this), 'OsmoDbSecretArn', {
      value: props.dbSecretArn,
      description: 'DB Secret ARN in Secrets Manager',
    });
    new cdk.CfnOutput(cdk.Stack.of(this), 'OsmoRedisEndpoint', {
      value: props.redisEndpoint,
      description: 'ElastiCache Redis endpoint',
    });
    new cdk.CfnOutput(cdk.Stack.of(this), 'OsmoRedisPort', {
      value: props.redisPort,
      description: 'ElastiCache Redis port',
    });
    new cdk.CfnOutput(cdk.Stack.of(this), 'OsmoDataBucket', {
      value: props.dataBucket.ref,
      description: 'OSMO Data S3 Bucket',
    });
  }
}
