import * as cdk from 'aws-cdk-lib';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface OsmoInstallProps {
  namePrefix: string;
  cluster: eks.Cluster;
  dbEndpoint: string;
  dbPort: string;
  redisEndpoint: string;
  redisPort: string;
  dataBucket: s3.CfnBucket;
}

export class OsmoInstallConstruct extends Construct {
  constructor(scope: Construct, id: string, props: OsmoInstallProps) {
    super(scope, id);

    const p = props.namePrefix;

    // OSMO namespace
    const namespace = props.cluster.addManifest('OsmoNamespace', {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: { name: 'osmo' },
    });

    // OSMO Helm chart
    const osmoChart = props.cluster.addHelmChart('OsmoHelm', {
      chart: 'osmo',
      repository: 'https://helm.nvidia.com/osmo',
      namespace: 'osmo',
      values: {
        global: {
          storageClass: 'gp3',
        },
        postgresql: {
          external: {
            enabled: true,
            host: props.dbEndpoint,
            port: parseInt(props.dbPort, 10),
            database: 'osmo',
            username: 'osmo',
            existingSecret: `${p}-db-secret`.toLowerCase(),
          },
        },
        redis: {
          external: {
            enabled: true,
            host: props.redisEndpoint,
            port: parseInt(props.redisPort, 10),
          },
        },
        storage: {
          s3: {
            bucket: props.dataBucket.ref,
            region: cdk.Aws.REGION,
          },
        },
      },
    });

    osmoChart.node.addDependency(namespace);

    // Outputs
    new cdk.CfnOutput(cdk.Stack.of(this), 'OsmoNamespace', {
      value: 'osmo',
      description: 'OSMO Kubernetes namespace',
    });
  }
}
