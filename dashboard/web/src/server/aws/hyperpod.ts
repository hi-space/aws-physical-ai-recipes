import {
  CreateClusterSchedulerConfigCommand,
  CreateComputeQuotaCommand,
  DeleteClusterSchedulerConfigCommand,
  DeleteComputeQuotaCommand,
  DescribeClusterCommand,
  DescribeClusterNodeCommand,
  DescribeClusterSchedulerConfigCommand,
  DescribeComputeQuotaCommand,
  ListClusterEventsCommand,
  ListClusterNodesCommand,
  ListClusterSchedulerConfigsCommand,
  ListClustersCommand,
  ListComputeQuotasCommand,
  UpdateClusterCommand,
  type ClusterInstanceGroupDetails,
  type ClusterInstanceGroupSpecification,
  type ClusterNodeSummary,
  type ClusterSummary,
} from '@aws-sdk/client-sagemaker';
import { badRequest, HttpError } from '../errors';
import { sagemaker } from './clients';

export async function listClusters(): Promise<ClusterSummary[]> {
  const out = await sagemaker().send(new ListClustersCommand({ MaxResults: 50 }));
  return out.ClusterSummaries ?? [];
}

export async function describeCluster(name: string) {
  return sagemaker().send(new DescribeClusterCommand({ ClusterName: name }));
}

export async function listNodes(name: string): Promise<ClusterNodeSummary[]> {
  const nodes: ClusterNodeSummary[] = [];
  let token: string | undefined;
  do {
    const out = await sagemaker().send(new ListClusterNodesCommand({ ClusterName: name, MaxResults: 100, NextToken: token }));
    nodes.push(...(out.ClusterNodeSummaries ?? []));
    token = out.NextToken;
  } while (token);
  return nodes;
}

export async function describeNode(name: string, nodeId: string) {
  return sagemaker().send(new DescribeClusterNodeCommand({ ClusterName: name, NodeId: nodeId }));
}

/**
 * Build the UpdateCluster InstanceGroups payload from DescribeCluster output,
 * changing only the target group's count. Mirrors scripts/scale-cluster.sh.
 */
export function buildScaleSpec(groups: ClusterInstanceGroupDetails[], group: string, count: number): ClusterInstanceGroupSpecification[] {
  if (!Number.isInteger(count) || count < 0) throw badRequest('count must be a non-negative integer');
  const target = groups.find((g) => g.InstanceGroupName === group);
  if (!target) throw badRequest(`Unknown instance group ${group}`);
  return groups.map((g) => {
    const spec: ClusterInstanceGroupSpecification = {
      InstanceGroupName: g.InstanceGroupName!,
      InstanceType: g.InstanceType!,
      InstanceCount: g.InstanceGroupName === group ? count : (g.TargetCount ?? g.CurrentCount ?? 0),
      ExecutionRole: g.ExecutionRole!,
      LifeCycleConfig: g.LifeCycleConfig!,
      ThreadsPerCore: g.ThreadsPerCore,
      InstanceStorageConfigs: g.InstanceStorageConfigs,
      OnStartDeepHealthChecks: g.OnStartDeepHealthChecks,
      TrainingPlanArn: g.TrainingPlanArn,
      OverrideVpcConfig: g.OverrideVpcConfig,
      ScheduledUpdateConfig: g.ScheduledUpdateConfig,
    };
    return spec;
  });
}

export async function scaleGroup(name: string, group: string, count: number, expectedCount?: number): Promise<void> {
  const desc = await describeCluster(name);
  const current = desc.InstanceGroups?.find((item) => item.InstanceGroupName === group);
  if (expectedCount !== undefined && ((current?.TargetCount ?? current?.CurrentCount ?? 0) !== expectedCount || desc.ClusterStatus !== 'InService')) throw new HttpError(409, '클러스터 구성이 변경되어 요청을 적용하지 않았습니다.');
  const spec = buildScaleSpec(desc.InstanceGroups ?? [], group, count);
  await sagemaker().send(new UpdateClusterCommand({ ClusterName: name, InstanceGroups: spec }));
}

export async function listEvents(name: string, max = 25) {
  const out = await sagemaker().send(new ListClusterEventsCommand({ ClusterName: name, MaxResults: max, SortBy: 'EventTime', SortOrder: 'Descending' }));
  return out.Events ?? [];
}

export async function listComputeQuotas(clusterArn?: string) {
  const out = await sagemaker().send(new ListComputeQuotasCommand({ ClusterArn: clusterArn, MaxResults: 100 }));
  const summaries = out.ComputeQuotaSummaries ?? [];
  return Promise.all(
    summaries.map(async (s) => {
      try {
        const d = await sagemaker().send(new DescribeComputeQuotaCommand({ ComputeQuotaId: s.ComputeQuotaId! }));
        return { ...s, detail: d };
      } catch {
        return { ...s, detail: undefined };
      }
    }),
  );
}

export async function listSchedulerConfigs(clusterArn?: string) {
  const out = await sagemaker().send(new ListClusterSchedulerConfigsCommand({ ClusterArn: clusterArn, MaxResults: 50 }));
  const list = out.ClusterSchedulerConfigSummaries ?? [];
  return Promise.all(
    list.map(async (s) => {
      try {
        const d = await sagemaker().send(new DescribeClusterSchedulerConfigCommand({ ClusterSchedulerConfigId: s.ClusterSchedulerConfigId! }));
        return { ...s, detail: d };
      } catch {
        return { ...s, detail: undefined };
      }
    }),
  );
}

export interface CreateQuotaInput {
  name: string;
  clusterArn: string;
  team: string;
  fairShareWeight?: number;
  instances: { instanceType: string; count: number }[];
  borrowLimit?: number;
  preempt?: 'LowerPriority' | 'Never';
  description?: string;
}

export async function createComputeQuota(i: CreateQuotaInput) {
  return sagemaker().send(
    new CreateComputeQuotaCommand({
      Name: i.name,
      ClusterArn: i.clusterArn,
      Description: i.description,
      ActivationState: 'Enabled',
      ComputeQuotaTarget: { TeamName: i.team, FairShareWeight: i.fairShareWeight ?? 50 },
      ComputeQuotaConfig: {
        ComputeQuotaResources: i.instances.map((x) => ({ InstanceType: x.instanceType as never, Count: x.count })),
        ResourceSharingConfig: { Strategy: i.borrowLimit === undefined ? 'DontLend' : 'LendAndBorrow', BorrowLimit: i.borrowLimit },
        PreemptTeamTasks: i.preempt ?? 'LowerPriority',
      },
    }),
  );
}
export async function deleteComputeQuota(id: string) {
  return sagemaker().send(new DeleteComputeQuotaCommand({ ComputeQuotaId: id }));
}
export async function createSchedulerConfig(name: string, clusterArn: string, priorityClasses: { name: string; weight: number }[], fairShare = true) {
  return sagemaker().send(
    new CreateClusterSchedulerConfigCommand({
      Name: name,
      ClusterArn: clusterArn,
      SchedulerConfig: { PriorityClasses: priorityClasses.map((p) => ({ Name: p.name, Weight: p.weight })), FairShare: fairShare ? 'Enabled' : 'Disabled' },
    }),
  );
}
export async function deleteSchedulerConfig(id: string) {
  return sagemaker().send(new DeleteClusterSchedulerConfigCommand({ ClusterSchedulerConfigId: id }));
}
