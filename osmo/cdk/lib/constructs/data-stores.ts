import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface DataStoresProps {
  namePrefix: string;
  vpc: ec2.CfnVPC;
  privateSubnets: ec2.CfnSubnet[];
  eksSecurityGroupId: string;
}

export class DataStoresConstruct extends Construct {
  public readonly bucket: s3.CfnBucket;
  public readonly dbEndpoint: string;
  public readonly dbPort: string;
  public readonly redisEndpoint: string;
  public readonly redisPort: string;
  public readonly dbSecret: secretsmanager.CfnSecret;

  constructor(scope: Construct, id: string, props: DataStoresProps) {
    super(scope, id);

    const p = props.namePrefix;

    // --- S3 Bucket ---
    this.bucket = new s3.CfnBucket(this, 'DataBucket', {
      bucketName: cdk.Fn.join('-', [
        'osmo-data',
        p.toLowerCase(),
        cdk.Aws.ACCOUNT_ID,
        cdk.Aws.REGION,
      ]),
      versioningConfiguration: { status: 'Enabled' },
      lifecycleConfiguration: {
        rules: [{
          id: 'TransitionToIA',
          status: 'Enabled',
          transitions: [{
            storageClass: 'INTELLIGENT_TIERING',
            transitionInDays: 30,
          }],
        }],
      },
      tags: [{ key: 'Name', value: `${p}-Data` }],
    });

    // --- Secrets Manager (DB Password) ---
    this.dbSecret = new secretsmanager.CfnSecret(this, 'DbSecret', {
      name: `${p}-db-secret`.toLowerCase(),
      description: 'OSMO RDS PostgreSQL credentials',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'osmo' }),
        generateStringKey: 'password',
        excludePunctuation: true,
        passwordLength: 32,
      },
      tags: [{ key: 'Name', value: `${p}-DB-Secret` }],
    });

    // --- RDS Security Group ---
    const dbSG = new ec2.CfnSecurityGroup(this, 'DbSG', {
      groupDescription: 'RDS PostgreSQL for OSMO',
      vpcId: props.vpc.ref,
      securityGroupIngress: [{
        ipProtocol: 'tcp',
        fromPort: 5432,
        toPort: 5432,
        sourceSecurityGroupId: props.eksSecurityGroupId,
        description: 'PostgreSQL from EKS',
      }],
      tags: [{ key: 'Name', value: `${p}-DB-SG` }],
    });

    // --- RDS Subnet Group ---
    const dbSubnetGroup = new rds.CfnDBSubnetGroup(this, 'DbSubnetGroup', {
      dbSubnetGroupDescription: 'OSMO RDS subnet group',
      subnetIds: props.privateSubnets.map(s => s.ref),
      tags: [{ key: 'Name', value: `${p}-DB-SubnetGroup` }],
    });

    // --- RDS PostgreSQL ---
    const dbInstance = new rds.CfnDBInstance(this, 'PostgresDB', {
      dbInstanceIdentifier: `${p}-postgres`.toLowerCase(),
      engine: 'postgres',
      engineVersion: '16.6',
      dbInstanceClass: 'db.t3.medium',
      allocatedStorage: '20',
      masterUsername: 'osmo',
      masterUserPassword: `{{resolve:secretsmanager:${this.dbSecret.ref}:SecretString:password}}`,
      vpcSecurityGroups: [dbSG.ref],
      dbSubnetGroupName: dbSubnetGroup.ref,
      multiAz: false,
      storageEncrypted: true,
      publiclyAccessible: false,
      tags: [{ key: 'Name', value: `${p}-Postgres` }],
    });

    this.dbEndpoint = dbInstance.attrEndpointAddress;
    this.dbPort = dbInstance.attrEndpointPort;

    // --- ElastiCache Security Group ---
    const redisSG = new ec2.CfnSecurityGroup(this, 'RedisSG', {
      groupDescription: 'ElastiCache Redis for OSMO',
      vpcId: props.vpc.ref,
      securityGroupIngress: [{
        ipProtocol: 'tcp',
        fromPort: 6379,
        toPort: 6379,
        sourceSecurityGroupId: props.eksSecurityGroupId,
        description: 'Redis from EKS',
      }],
      tags: [{ key: 'Name', value: `${p}-Redis-SG` }],
    });

    // --- ElastiCache Subnet Group ---
    const cacheSubnetGroup = new elasticache.CfnSubnetGroup(this, 'CacheSubnetGroup', {
      description: 'OSMO Redis subnet group',
      subnetIds: props.privateSubnets.map(s => s.ref),
      cacheSubnetGroupName: `${p}-redis-subnet`.toLowerCase(),
    });

    // --- ElastiCache Redis ---
    const redisCluster = new elasticache.CfnCacheCluster(this, 'RedisCluster', {
      clusterName: `${p}-redis`.toLowerCase(),
      engine: 'redis',
      cacheNodeType: 'cache.t3.medium',
      numCacheNodes: 1,
      vpcSecurityGroupIds: [redisSG.ref],
      cacheSubnetGroupName: cacheSubnetGroup.ref,
      tags: [{ key: 'Name', value: `${p}-Redis` }],
    });

    this.redisEndpoint = redisCluster.attrRedisEndpointAddress;
    this.redisPort = redisCluster.attrRedisEndpointPort;
  }
}
