import { DescribeAddonCommand, ListAddonsCommand } from '@aws-sdk/client-eks';
import { backendConfig as config } from '../backends/context';
import { eks } from '../aws/clients';
import * as hp from '../aws/hyperpod';
import { listNodes as listK8sNodes, type Node } from '../k8s/resources';
import { describeInstanceTypes } from '../aws/instance-catalog';
import { getText, parseS3Uri } from '../aws/s3';

export interface ClusterGroup {
  name: string;
  instanceType: string;
  current: number;
  target: number;
  status?: string;
  /** GPU count from EC2 catalog; undefined when catalog lookup failed */
  gpuCount?: number;
  /** vCPU count from EC2 catalog; undefined when catalog lookup failed */
  vCpu?: number;
  /** Memory in GiB from EC2 catalog; undefined when catalog lookup failed */
  memoryGiB?: number;
  /** GPU name from EC2 catalog; undefined when catalog lookup failed or no GPU */
  gpuName?: string;
  /** Role only set for Slurm clusters and only when readable from provisioning_parameters.json */
  role?: 'controller' | 'login' | 'worker';
  /**
   * Derived boolean for backward compatibility (used by OverviewPage).
   * true when gpuCount > 0, false when gpuCount === 0, undefined when gpuCount is unknown.
   */
  isGpu?: boolean;
}

export interface ClusterSummary {
  name: string;
  orchestrator: 'eks' | 'slurm';
  status?: string;
  arn?: string;
  createdAt?: string;
  failureMessage?: string;
  groups: ClusterGroup[];
  nodes: { id: string; group: string; instanceType: string; status: string; launchTime?: string }[];
}

export function knownClusters(): { name: string; orchestrator: 'eks' | 'slurm' }[] {
  const c = config();
  const out: { name: string; orchestrator: 'eks' | 'slurm' }[] = [];
  if (c.eks) out.push({ name: c.eks.hyperPodClusterName, orchestrator: 'eks' });
  if (c.slurm) out.push({ name: c.slurm.hyperPodClusterName, orchestrator: 'slurm' });
  return out;
}

/**
 * Read provisioning_parameters.json from the cluster's LifeCycleConfig.SourceS3Uri.
 * Returns the role mapping: { controller_group, login_group, worker_groups[].instance_group_name }.
 * Returns undefined if the file cannot be read.
 */
export async function readClusterRoles(sourceS3Uri?: string): Promise<{ controller_group?: string; login_group?: string; worker_groups?: Array<{ instance_group_name?: string }> } | undefined> {
  if (!sourceS3Uri) return undefined;
  try {
    const { bucket, key } = parseS3Uri(sourceS3Uri);
    const provisioning = key.endsWith('/') ? key + 'provisioning_parameters.json' : key + '/provisioning_parameters.json';
    const text = await getText(bucket, provisioning);
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Map a group name to its role based on provisioning_parameters.json.
 * Matches against controller_group, login_group, and worker_groups[].instance_group_name.
 */
export function mapGroupToRole(
  groupName: string,
  roleMapping?: { controller_group?: string; login_group?: string; worker_groups?: Array<{ instance_group_name?: string }> },
): 'controller' | 'login' | 'worker' | undefined {
  if (!roleMapping) return undefined;
  if (groupName === roleMapping.controller_group) return 'controller';
  if (groupName === roleMapping.login_group) return 'login';
  if (roleMapping.worker_groups?.some((w) => w.instance_group_name === groupName)) return 'worker';
  return undefined;
}

export async function summarizeCluster(name: string, orchestrator: 'eks' | 'slurm'): Promise<ClusterSummary> {
  const [d, nodes] = await Promise.all([hp.describeCluster(name), hp.listNodes(name).catch(() => [])]);

  // Fetch instance type specs
  const instanceTypeNames = (d.InstanceGroups ?? []).map((g) => g.InstanceType).filter(Boolean) as string[];
  const catalog = await describeInstanceTypes(instanceTypeNames).catch(() => new Map());

  // Read provisioning parameters (Slurm only) to get role mapping
  let roleMapping: Awaited<ReturnType<typeof readClusterRoles>> | undefined;
  if (orchestrator === 'slurm' && d.InstanceGroups?.[0]?.LifeCycleConfig?.SourceS3Uri) {
    roleMapping = await readClusterRoles(d.InstanceGroups[0].LifeCycleConfig.SourceS3Uri);
  }

  return {
    name,
    orchestrator,
    status: d.ClusterStatus,
    arn: d.ClusterArn,
    createdAt: d.CreationTime?.toISOString(),
    failureMessage: d.FailureMessage,
    groups: (d.InstanceGroups ?? []).map((g) => {
      const instanceTypeName = g.InstanceType ?? '';
      const catalogEntry = catalog.get(instanceTypeName.replace(/^ml\./, ''));
      return {
        name: g.InstanceGroupName ?? '',
        instanceType: instanceTypeName,
        current: g.CurrentCount ?? 0,
        target: g.TargetCount ?? 0,
        status: g.Status,
        gpuCount: catalogEntry?.gpuCount,
        vCpu: catalogEntry?.vCpu,
        memoryGiB: catalogEntry?.memoryMiB ? catalogEntry.memoryMiB / 1024 : undefined,
        gpuName: catalogEntry?.gpuName,
        role: orchestrator === 'slurm' ? mapGroupToRole(g.InstanceGroupName ?? '', roleMapping) : undefined,
        isGpu: catalogEntry?.gpuCount !== undefined ? catalogEntry.gpuCount > 0 : undefined,
      };
    }),
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
