import * as cdk from 'aws-cdk-lib';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface OsmoInstallProps {
  namePrefix: string;
  cluster: eks.Cluster;
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

    // OSMO namespace
    const namespace = props.cluster.addManifest('OsmoNamespace', {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: { name: 'osmo' },
    });

    // Kubernetes ExternalSecret/Secret for DB credentials
    // Uses CSI Secrets Store driver with AWS Secrets Manager integration
    const dbK8sSecret = props.cluster.addManifest('OsmoDbSecret', {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: `${p}-db-secret`.toLowerCase(),
        namespace: 'osmo',
      },
      type: 'Opaque',
      stringData: {
        password: `{{resolve:secretsmanager:${props.dbSecretArn}:SecretString:password}}`,
      },
    });
    dbK8sSecret.node.addDependency(namespace);

    // OSMO Helm chart
    // NOTE: OSMO는 현재 공식 Helm 차트를 제공하지 않으며 자체 설치 방식을 사용합니다.
    // 아래는 Helm 기반 설치가 가능해질 경우의 설정 예시입니다.
    // 실제 설치는 OSMO 공식 문서를 참고하세요: https://github.com/NVIDIA/OSMO
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
    osmoChart.node.addDependency(dbK8sSecret);

    // Outputs
    new cdk.CfnOutput(cdk.Stack.of(this), 'OsmoNamespace', {
      value: 'osmo',
      description: 'OSMO Kubernetes namespace',
    });
  }
}
