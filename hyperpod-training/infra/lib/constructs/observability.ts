import * as cdk from 'aws-cdk-lib';
import * as aps from 'aws-cdk-lib/aws-aps';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as grafana from 'aws-cdk-lib/aws-grafana';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface ObservabilityProps {
  namePrefix: string;
  eksCluster: eks.Cluster;
  /** HyperPod 클러스터 CFN 리소스. 두 애드온은 HyperPod 노드가 1대 이상 있어야 설치되므로 이에 의존한다. */
  hyperpodCluster: cdk.CfnResource;
  podIdentityAgent: eks.CfnAddon;
  enableObservability: boolean;
  enableTaskGovernance: boolean;
}

/**
 * HyperPod 관측(observability) + task governance 애드온.
 *
 * - `amazon-sagemaker-hyperpod-observability`: node/DCGM/kube-state/EFA exporter 와 OTel collector 를
 *   배포하고 메트릭을 AMP 로 remote-write, 로그를 CloudWatch 로 보낸다. AMG 워크스페이스 ARN 을 주면
 *   HyperPod 대시보드를 그 워크스페이스에 연결한다. 콘솔의 "Quick install" 이 하는 일을 IaC 로 옮긴 것.
 * - `amazon-sagemaker-hyperpod-taskgovernance`: Kueue 를 설치하고 cluster policy / compute quota 를
 *   ClusterQueue·LocalQueue·WorkloadPriorityClass 로 동기화한다. 정책 자체는 CloudFormation 리소스 타입이
 *   없어 AWS CLI(scripts/eks/create-governance.sh)로 만든다.
 */
export class ObservabilityConstruct extends Construct {
  public readonly ampWorkspace?: aps.CfnWorkspace;
  public readonly grafanaWorkspace?: grafana.CfnWorkspace;
  /** https://<workspace endpoint> (observability 가 켜진 경우). */
  public readonly grafanaUrl?: string;

  constructor(scope: Construct, id: string, props: ObservabilityProps) {
    super(scope, id);
    const p = props.namePrefix;
    const stack = cdk.Stack.of(this);

    if (props.enableTaskGovernance) {
      const tg = new eks.CfnAddon(this, 'TaskGovernanceAddon', {
        clusterName: props.eksCluster.clusterName,
        addonName: 'amazon-sagemaker-hyperpod-taskgovernance',
        resolveConflicts: 'OVERWRITE',
      });
      tg.addDependency(props.hyperpodCluster);
    }

    if (!props.enableObservability) {
      return;
    }

    this.ampWorkspace = new aps.CfnWorkspace(this, 'Amp', {
      alias: p.toLowerCase(),
      tags: [{ key: 'Name', value: `${p}-AMP` }],
    });

    // Grafana 는 IAM Identity Center 로 로그인한다. CUSTOMER_MANAGED 롤이 AMP 를 읽는다.
    const grafanaRole = new iam.Role(this, 'GrafanaRole', {
      assumedBy: new iam.ServicePrincipal('grafana.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonPrometheusQueryAccess'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonGrafanaCloudWatchAccess'),
      ],
    });
    this.grafanaWorkspace = new grafana.CfnWorkspace(this, 'Grafana', {
      name: p,
      description: 'HyperPod EKS observability dashboards',
      accountAccessType: 'CURRENT_ACCOUNT',
      authenticationProviders: ['AWS_SSO'],
      permissionType: 'CUSTOMER_MANAGED',
      roleArn: grafanaRole.roleArn,
      dataSources: ['PROMETHEUS', 'CLOUDWATCH'],
      pluginAdminEnabled: true,
    });

    // OTel collector 의 pod identity 롤 (애드온 podIdentityConfiguration 이 요구하는 SA).
    const otelRole = new iam.Role(this, 'OtelCollectorRole', {
      assumedBy: new iam.ServicePrincipal('pods.eks.amazonaws.com').withSessionTags(),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonPrometheusRemoteWriteAccess'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchAgentServerPolicy'),
      ],
    });

    const configuration = {
      ampWorkspace: {
        arn: this.ampWorkspace.attrArn,
        prometheusEndpoint: this.ampWorkspace.attrPrometheusEndpoint,
      },
      amgWorkspace: {
        arn: cdk.Fn.join('', ['arn:aws:grafana:', cdk.Aws.REGION, ':', cdk.Aws.ACCOUNT_ID, ':/workspaces/', this.grafanaWorkspace.attrId]),
      },
      metricsProvider: {
        clusterMetrics: { level: 'ADVANCED' },
        nodeMetrics: { level: 'ADVANCED' },
        acceleratedComputeMetrics: { level: 'ADVANCED' },
        networkMetrics: { level: 'BASIC' },
        taskGovernanceMetrics: { level: 'ADVANCED' },
        trainingMetrics: { level: 'ADVANCED' },
        logging: { enabled: true },
      },
    };
    const obs = new eks.CfnAddon(this, 'ObservabilityAddon', {
      clusterName: props.eksCluster.clusterName,
      addonName: 'amazon-sagemaker-hyperpod-observability',
      resolveConflicts: 'OVERWRITE',
      configurationValues: stack.toJsonString(configuration),
      podIdentityAssociations: [
        { roleArn: otelRole.roleArn, serviceAccount: 'hyperpod-observability-operator-otel-collector' },
      ],
    });
    obs.addDependency(props.hyperpodCluster);
    obs.addDependency(props.podIdentityAgent);
    obs.addDependency(this.ampWorkspace);
    obs.addDependency(this.grafanaWorkspace);
    this.grafanaUrl = cdk.Fn.join('', ['https://', this.grafanaWorkspace.attrEndpoint]);

  }
}
