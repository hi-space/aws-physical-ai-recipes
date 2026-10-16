import * as cdk from 'aws-cdk-lib';
import * as eks from 'aws-cdk-lib/aws-eks';
import { Construct } from 'constructs';

export interface TaskGovernanceProps {
  eksCluster: eks.Cluster;
  /** HyperPod 클러스터 CFN 리소스. 애드온은 HyperPod 노드가 1대 이상 있어야 설치되므로 이에 의존한다. */
  hyperpodCluster: cdk.CfnResource;
}

/**
 * `amazon-sagemaker-hyperpod-taskgovernance` 애드온.
 *
 * Kueue 를 설치하고 cluster policy / compute quota 를 ClusterQueue·LocalQueue·WorkloadPriorityClass 로
 * 동기화한다. 정책 자체는 CloudFormation 리소스 타입이 없어 AWS CLI(scripts/eks/create-governance.sh)로 만든다.
 *
 * 짝이 되는 `amazon-sagemaker-hyperpod-observability` 애드온(AMP + Grafana)은 이 스택에 없다 —
 * 리전마다 제공 여부가 달라(2026-10-16 기준 ap-northeast-2 에 없음) 미지원 리전에서 CreateAddon 이
 * 400 을 내면 CloudFormation 이 스택 전체를 롤백해 VPC·FSx·HyperPod 클러스터까지 되돌린다. 그래서
 * 관측은 배포 후 추가 설치(scripts/eks/install-observability.sh)로 분리했다. task governance 애드온은
 * 모든 리전에 있어 여기 남는다.
 */
export class TaskGovernanceConstruct extends Construct {
  constructor(scope: Construct, id: string, props: TaskGovernanceProps) {
    super(scope, id);

    const addon = new eks.CfnAddon(this, 'Addon', {
      clusterName: props.eksCluster.clusterName,
      addonName: 'amazon-sagemaker-hyperpod-taskgovernance',
      resolveConflicts: 'OVERWRITE',
    });
    addon.addDependency(props.hyperpodCluster);
  }
}
