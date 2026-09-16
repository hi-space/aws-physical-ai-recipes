import { DescribeAddonCommand, ListAddonsCommand } from '@aws-sdk/client-eks';
import { config } from '../config';
import { eks } from '../aws/clients';
import * as hp from '../aws/hyperpod';
import { listNodes as listK8sNodes, type Node } from '../k8s/resources';

export interface ClusterSummary {
  name: string;
  orchestrator: 'eks' | 'slurm';
  status?: string;
  arn?: string;
  createdAt?: string;
  failureMessage?: string;
  groups: { name: string; instanceType: string; current: number; target: number; status?: string; isGpu: boolean; isSystem: boolean }[];
  nodes: { id: string; group: string; instanceType: string; status: string; launchTime?: string }[];
}

export function knownClusters(): { name: string; orchestrator: 'eks' | 'slurm' }[] {
  const c = config();
  const out: { name: string; orchestrator: 'eks' | 'slurm' }[] = [];
  if (c.eks) out.push({ name: c.eks.hyperPodClusterName, orchestrator: 'eks' });
  if (c.slurm) out.push({ name: c.slurm.hyperPodClusterName, orchestrator: 'slurm' });
  return out;
}

export async function summarizeCluster(name: string, orchestrator: 'eks' | 'slurm'): Promise<ClusterSummary> {
  const [d, nodes] = await Promise.all([hp.describeCluster(name), hp.listNodes(name).catch(() => [])]);
  return {
    name,
    orchestrator,
    status: d.ClusterStatus,
    arn: d.ClusterArn,
    createdAt: d.CreationTime?.toISOString(),
    failureMessage: d.FailureMessage,
    groups: (d.InstanceGroups ?? []).map((g) => ({
      name: g.InstanceGroupName ?? '',
      instanceType: g.InstanceType ?? '',
      current: g.CurrentCount ?? 0,
      target: g.TargetCount ?? 0,
      status: g.Status,
      isGpu: /^ml\.(g|p)/.test(g.InstanceType ?? ''),
      isSystem: g.InstanceGroupName === 'head' || (orchestrator === 'eks' && g.InstanceGroupName === 'cpu-c5-4x'),
    })),
    nodes: nodes.map((n) => ({ id: n.InstanceId ?? '', group: n.InstanceGroupName ?? '', instanceType: n.InstanceType ?? '', status: n.InstanceStatus?.Status ?? '', launchTime: n.LaunchTime?.toISOString() })),
  };
}

export async function allClusters(): Promise<ClusterSummary[]> {
  return Promise.all(knownClusters().map((k) => summarizeCluster(k.name, k.orchestrator).catch((e) => ({ name: k.name, orchestrator: k.orchestrator, status: `error: ${(e as Error).message}`, groups: [], nodes: [] }))));
}

export interface K8sNodeView {
  name: string;
  instanceType?: string;
  group?: string;
  health?: string;
  ready: boolean;
  gpuCapacity: number;
  gpuAllocatable: number;
  cpu?: string;
  memory?: string;
  kubelet?: string;
  internalIp?: string;
  age?: string;
  taints: string[];
  unschedulable: boolean;
}

export function viewNode(n: Node): K8sNodeView {
  const l = n.metadata.labels ?? {};
  return {
    name: n.metadata.name,
    instanceType: l['node.kubernetes.io/instance-type'],
    group: l['sagemaker.amazonaws.com/instance-group-name'],
    health: l['sagemaker.amazonaws.com/node-health-status'],
    ready: n.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True') ?? false,
    gpuCapacity: Number(n.status?.capacity?.['nvidia.com/gpu'] ?? 0),
    gpuAllocatable: Number(n.status?.allocatable?.['nvidia.com/gpu'] ?? 0),
    cpu: n.status?.allocatable?.cpu,
    memory: n.status?.allocatable?.memory,
    kubelet: n.status?.nodeInfo?.kubeletVersion,
    internalIp: n.status?.addresses?.find((a) => a.type === 'InternalIP')?.address,
    age: n.metadata.creationTimestamp,
    taints: (n.spec?.taints ?? []).map((t) => `${t.key}${t.value ? '=' + t.value : ''}:${t.effect}`),
    unschedulable: Boolean(n.spec?.unschedulable),
  };
}

export async function k8sNodes(): Promise<K8sNodeView[]> {
  if (!config().eks) return [];
  return (await listK8sNodes()).map(viewNode);
}

export async function eksAddons() {
  const c = config().eks;
  if (!c) return [];
  const names = (await eks().send(new ListAddonsCommand({ clusterName: c.eksClusterName }))).addons ?? [];
  return Promise.all(
    names.map(async (addonName) => {
      const d = await eks().send(new DescribeAddonCommand({ clusterName: c.eksClusterName, addonName }));
      return { name: addonName, version: d.addon?.addonVersion, status: d.addon?.status, health: d.addon?.health?.issues?.length ?? 0 };
    }),
  );
}
