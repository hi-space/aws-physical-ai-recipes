import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as aps from 'aws-cdk-lib/aws-aps';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as grafana from 'aws-cdk-lib/aws-grafana';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

/**
 * Grafana 제공 방식.
 * - self-hosted (기본): Grafana Helm 차트를 클러스터 안(namespace grafana)에 설치하고 AMP 를 SigV4 데이터소스로 읽는다.
 *   `kubectl port-forward` 로 접속하므로 IAM Identity Center 가 없어도 된다.
 * - amg: Amazon Managed Grafana 워크스페이스(AWS_SSO 인증). IAM Identity Center **조직 인스턴스**가 있는 계정에서만
 *   만들어진다(계정 인스턴스는 "SSO is not enabled in any region" 으로 거부됨). HyperPod observability 애드온에
 *   워크스페이스 ARN 을 넘겨 관리형 대시보드를 연결한다.
 * - none: Grafana 없이 AMP 만.
 */
export type GrafanaMode = 'self-hosted' | 'amg' | 'none';
export const GRAFANA_MODES: readonly GrafanaMode[] = ['self-hosted', 'amg', 'none'];

/** Grafana Helm 차트 버전(https://grafana.github.io/helm-charts). Grafana 12.3. */
export const GRAFANA_CHART_VERSION = '10.5.15';
export const GRAFANA_NAMESPACE = 'grafana';

export interface ObservabilityProps {
  namePrefix: string;
  eksCluster: eks.Cluster;
  /** HyperPod 클러스터 CFN 리소스. 두 애드온은 HyperPod 노드가 1대 이상 있어야 설치되므로 이에 의존한다. */
  hyperpodCluster: cdk.CfnResource;
  podIdentityAgent: eks.CfnAddon;
  enableObservability: boolean;
  enableTaskGovernance: boolean;
  grafanaMode: GrafanaMode;
}

/**
 * HyperPod 관측(observability) + task governance 애드온.
 *
 * - `amazon-sagemaker-hyperpod-observability`: node/DCGM/kube-state/EFA exporter 와 OTel collector 를
 *   배포하고 메트릭을 AMP 로 remote-write, 로그를 CloudWatch 로 보낸다. 콘솔의 "Quick install" 이 하는 일을
 *   IaC 로 옮긴 것. Grafana 는 grafanaMode 에 따라 in-cluster 또는 AMG.
 * - `amazon-sagemaker-hyperpod-taskgovernance`: Kueue 를 설치하고 cluster policy / compute quota 를
 *   ClusterQueue·LocalQueue·WorkloadPriorityClass 로 동기화한다. 정책 자체는 CloudFormation 리소스 타입이
 *   없어 AWS CLI(scripts/eks/create-governance.sh)로 만든다.
 */
export class ObservabilityConstruct extends Construct {
  public readonly ampWorkspace?: aps.CfnWorkspace;
  public readonly grafanaWorkspace?: grafana.CfnWorkspace;
  /** AMG: https://<workspace endpoint>. self-hosted: port-forward 후 http://localhost:3000. */
  public grafanaUrl?: string;
  /** self-hosted 접속 절차 (Output GrafanaAccess). */
  public grafanaAccessCommand?: string;

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

    const configuration: Record<string, unknown> = {
      ampWorkspace: {
        arn: this.ampWorkspace.attrArn,
        prometheusEndpoint: this.ampWorkspace.attrPrometheusEndpoint,
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
    const addonDeps: cdk.CfnResource[] = [props.hyperpodCluster, props.podIdentityAgent, this.ampWorkspace];

    if (props.grafanaMode === 'amg') {
      const grafanaRole = new iam.Role(this, 'GrafanaRole', {
        assumedBy: new iam.ServicePrincipal('grafana.amazonaws.com'),
        managedPolicies: [
          iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonPrometheusQueryAccess'),
          iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonGrafanaCloudWatchAccess'),
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
      configuration.amgWorkspace = {
        arn: cdk.Fn.join('', ['arn:aws:grafana:', cdk.Aws.REGION, ':', cdk.Aws.ACCOUNT_ID, ':/workspaces/', this.grafanaWorkspace.attrId]),
      };
      addonDeps.push(this.grafanaWorkspace);
      this.grafanaUrl = cdk.Fn.join('', ['https://', this.grafanaWorkspace.attrEndpoint]);
    } else if (props.grafanaMode === 'self-hosted') {
      this.installSelfHostedGrafana(props);
    }

    // OTel collector 의 pod identity 롤 (애드온 podIdentityConfiguration 이 요구하는 SA).
    const otelRole = new iam.Role(this, 'OtelCollectorRole', {
      assumedBy: new iam.ServicePrincipal('pods.eks.amazonaws.com').withSessionTags(),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonPrometheusRemoteWriteAccess'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchAgentServerPolicy'),
      ],
    });
    const obs = new eks.CfnAddon(this, 'ObservabilityAddon', {
      clusterName: props.eksCluster.clusterName,
      addonName: 'amazon-sagemaker-hyperpod-observability',
      resolveConflicts: 'OVERWRITE',
      configurationValues: stack.toJsonString(configuration),
      podIdentityAssociations: [
        { roleArn: otelRole.roleArn, serviceAccount: 'hyperpod-observability-operator-otel-collector' },
      ],
    });
    addonDeps.forEach((d) => obs.addDependency(d));
  }

  /**
   * In-cluster Grafana (Helm) — AMP 를 SigV4 로 읽는 데이터소스 + 커뮤니티 대시보드(DCGM, Node Exporter,
   * Kubernetes Views) + 워크숍 전용 task governance 대시보드(eks/grafana-dashboards). admin 비밀번호는 차트가
   * 생성하는 Secret `grafana` 에 있다.
   */
  private installSelfHostedGrafana(props: ObservabilityProps) {
    const amp = this.ampWorkspace!;
    const grafanaRole = new iam.Role(this, 'GrafanaPodRole', {
      assumedBy: new iam.ServicePrincipal('pods.eks.amazonaws.com').withSessionTags(),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonPrometheusQueryAccess')],
    });
    const association = new eks.CfnPodIdentityAssociation(this, 'GrafanaPodIdentity', {
      clusterName: props.eksCluster.clusterName,
      namespace: GRAFANA_NAMESPACE,
      serviceAccount: 'grafana',
      roleArn: grafanaRole.roleArn,
    });
    association.addDependency(props.podIdentityAgent);

    const governanceDashboard = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', 'eks', 'grafana-dashboards', 'hyperpod-task-governance.json'),
      'utf8',
    );

    const chart = props.eksCluster.addHelmChart('Grafana', {
      chart: 'grafana',
      repository: 'https://grafana.github.io/helm-charts',
      version: GRAFANA_CHART_VERSION,
      release: 'grafana',
      namespace: GRAFANA_NAMESPACE,
      createNamespace: true,
      wait: false,
      timeout: cdk.Duration.minutes(10),
      values: {
        serviceAccount: { create: true, name: 'grafana' },
        // 애드온 파드와 함께 상시 시스템 노드(cpu-c5-4x)에 두고 GPU 노드에는 올리지 않는다.
        nodeSelector: { 'node.kubernetes.io/instance-type': 'ml.c5.4xlarge' },
        env: { GF_AUTH_SIGV4_AUTH_ENABLED: 'true' },
        resources: { requests: { cpu: '250m', memory: '512Mi' }, limits: { memory: '1Gi' } },
        datasources: {
          'datasources.yaml': {
            apiVersion: 1,
            datasources: [{
              name: 'AMP',
              uid: 'amp',
              type: 'prometheus',
              access: 'proxy',
              isDefault: true,
              url: amp.attrPrometheusEndpoint,
              jsonData: { sigV4Auth: true, sigV4AuthType: 'default', sigV4Region: cdk.Aws.REGION, httpMethod: 'POST' },
            }],
          },
        },
        dashboardProviders: {
          'dashboardproviders.yaml': {
            apiVersion: 1,
            providers: [{
              name: 'hyperpod',
              orgId: 1,
              folder: 'HyperPod',
              type: 'file',
              disableDeletion: false,
              editable: true,
              options: { path: '/var/lib/grafana/dashboards/hyperpod' },
            }],
          },
        },
        dashboards: {
          hyperpod: {
            'hyperpod-task-governance': { json: governanceDashboard },
            'nvidia-dcgm': { gnetId: 12239, revision: 2, datasource: 'AMP' },
            'node-exporter-full': { gnetId: 1860, revision: 45, datasource: 'AMP' },
            'kubernetes-views-global': { gnetId: 15757, revision: 43, datasource: 'AMP' },
          },
        },
      },
    });
    chart.node.addDependency(association);

    this.grafanaUrl = 'http://localhost:3000';
    this.grafanaAccessCommand =
      `kubectl port-forward -n ${GRAFANA_NAMESPACE} svc/grafana 3000:80  # then http://localhost:3000, user admin, password: ` +
      `kubectl get secret -n ${GRAFANA_NAMESPACE} grafana -o jsonpath='{.data.admin-password}' | base64 -d`;
  }
}
