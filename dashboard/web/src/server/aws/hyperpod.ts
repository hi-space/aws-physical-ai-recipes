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
  BatchDeleteClusterNodesCommand,
  BatchRebootClusterNodesCommand,
  BatchReplaceClusterNodesCommand,
  UpdateComputeQuotaCommand,
  SageMakerClient,
  type DescribeClusterResponse,
  type ClusterInstanceGroupDetails,
  type ClusterInstanceGroupSpecification,
  type ClusterNodeSummary,
  type ClusterSummary,
} from '@aws-sdk/client-sagemaker';
import { badRequest, HttpError } from '../errors';
import { sagemaker } from './clients';
import { config } from '../config';
import { createHash } from 'node:crypto';

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
  const seen = new Set<string>();
  do {
    const out = await sagemaker().send(new ListClusterNodesCommand({ ClusterName: name, MaxResults: 100, NextToken: token }));
    nodes.push(...(out.ClusterNodeSummaries ?? []));
    token = out.NextToken;
    if (token && (seen.has(token) || seen.size >= 100)) throw new Error('HyperPod node inventory is incomplete');
    if (token) seen.add(token);
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
      MinInstanceCount: g.MinCount,
    };
    // These have Describe/request shapes that cannot be safely round-tripped by
    // the homogeneous on-demand scaler. Reject them instead of discarding fields.
    if (g.InstanceGroupName === group && (g.InstanceRequirements || g.CapacityRequirements || g.AutoPatchConfig || g.KubernetesConfig || g.SlurmConfig || g.NetworkInterface)) {
      throw badRequest('복합 instance group 설정은 이 스케일러에서 변경하지 않습니다.');
    }
    return spec;
  });
}

export function clusterSpecHash(cluster: DescribeClusterResponse): string {
  const stable = (value: unknown): string => {
    if (value instanceof Date) return JSON.stringify(value.toISOString());
    if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.entries(value).filter(([k, v]) => k !== '$metadata' && v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;
    return JSON.stringify(value);
  };
  return createHash('sha256').update(stable({ ...cluster, InstanceGroups: [...(cluster.InstanceGroups ?? [])].sort((a, b) => (a.InstanceGroupName ?? '').localeCompare(b.InstanceGroupName ?? '')) })).digest('hex');
}
function assertObserved(cluster: DescribeClusterResponse, expectedHash?: string) {
  if (!expectedHash || clusterSpecHash(cluster) !== expectedHash || cluster.ClusterStatus !== 'InService') throw new HttpError(409, '관측한 클러스터 전체 설정이 변경되었습니다. 계획을 다시 검토하세요.', 'scale_spec_changed');
}
// Capacity RPCs deliberately have no SDK retries after an ambiguous response.
const capacityClient = () => new SageMakerClient({ region: config().region, maxAttempts: 1 });
export async function scaleGroup(name: string, group: string, count: number, expectedCount?: number, expectedHash?: string): Promise<void> {
  const desc = await describeCluster(name);
  assertObserved(desc, expectedHash);
  const current = desc.InstanceGroups?.find((item) => item.InstanceGroupName === group);
  if (expectedCount !== undefined && ((current?.TargetCount ?? current?.CurrentCount ?? 0) !== expectedCount || desc.ClusterStatus !== 'InService')) throw new HttpError(409, '클러스터 구성이 변경되어 요청을 적용하지 않았습니다.');
  if (expectedCount === undefined || count < expectedCount) throw badRequest('축소에는 검증된 개별 노드 삭제 계획이 필요합니다.');
  const spec = buildScaleSpec(desc.InstanceGroups ?? [], group, count).filter(item => item.InstanceGroupName === group);
  await capacityClient().send(new UpdateClusterCommand({ ClusterName: name, InstanceGroups: spec }), { abortSignal: AbortSignal.timeout(30_000) });
}
export async function deleteIdleNodes(name: string, nodeIds: string[], expectedHash: string) {
  if (!nodeIds.length || nodeIds.length > 99 || new Set(nodeIds).size !== nodeIds.length || nodeIds.some(id => !/^i-[a-f0-9]{8}(?:[a-f0-9]{9})?$/.test(id))) throw badRequest('Invalid bounded node deletion set');
  assertObserved(await describeCluster(name), expectedHash);
  return capacityClient().send(new BatchDeleteClusterNodesCommand({ ClusterName: name, NodeIds: nodeIds }), { abortSignal: AbortSignal.timeout(30_000) });
}

const INSTANCE_ID = /^i-[a-f0-9]{8}(?:[a-f0-9]{9})?$/;
/**
 * HyperPod node recovery APIs (docs: "Manually quarantine, replace, or reboot a node"). One node per call from the UI;
 * no SDK retries because a retried reboot/replace after an ambiguous response would act twice.
 */
export async function rebootNodes(name: string, nodeIds: string[]) {
  if (!nodeIds.length || nodeIds.length > 25 || nodeIds.some((id) => !INSTANCE_ID.test(id))) throw badRequest('Invalid node id set');
  return capacityClient().send(new BatchRebootClusterNodesCommand({ ClusterName: name, NodeIds: nodeIds }), { abortSignal: AbortSignal.timeout(30_000) });
}
export async function replaceNodes(name: string, nodeIds: string[]) {
  if (!nodeIds.length || nodeIds.length > 25 || nodeIds.some((id) => !INSTANCE_ID.test(id))) throw badRequest('Invalid node id set');
  return capacityClient().send(new BatchReplaceClusterNodesCommand({ ClusterName: name, NodeIds: nodeIds }), { abortSignal: AbortSignal.timeout(30_000) });
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

export async function describeComputeQuota(id: string) {
  return sagemaker().send(new DescribeComputeQuotaCommand({ ComputeQuotaId: id }));
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
export interface UpdateQuotaInput {
  id: string;
  /** DescribeComputeQuota.ComputeQuotaVersion observed by the caller; SageMaker rejects a stale version. */
  targetVersion: number;
  team: string;
  fairShareWeight: number;
  instances: { instanceType: string; count: number }[];
  borrowLimit?: number;
  preempt: 'LowerPriority' | 'Never';
  activationState: 'Enabled' | 'Disabled';
  description?: string;
}
export async function updateComputeQuota(i: UpdateQuotaInput) {
  return sagemaker().send(
    new UpdateComputeQuotaCommand({
      ComputeQuotaId: i.id,
      TargetVersion: i.targetVersion,
      Description: i.description,
      ActivationState: i.activationState,
      ComputeQuotaTarget: { TeamName: i.team, FairShareWeight: i.fairShareWeight },
      ComputeQuotaConfig: {
        ComputeQuotaResources: i.instances.map((x) => ({ InstanceType: x.instanceType as never, Count: x.count })),
        ResourceSharingConfig: { Strategy: i.borrowLimit === undefined ? 'DontLend' : 'LendAndBorrow', BorrowLimit: i.borrowLimit },
        PreemptTeamTasks: i.preempt,
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
