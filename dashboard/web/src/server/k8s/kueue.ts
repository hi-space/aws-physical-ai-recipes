import { k8sGetOrNull, k8sJson } from './client';
import type { K8sList, Meta } from './resources';

export interface ClusterQueue {
  metadata: Meta;
  spec: { cohort?: string; namespaceSelector?: unknown; resourceGroups?: { coveredResources: string[]; flavors: { name: string; resources: { name: string; nominalQuota: string; borrowingLimit?: string; lendingLimit?: string }[] }[] }[]; preemption?: Record<string, string>; fairSharing?: { weight?: string } };
  status?: { pendingWorkloads?: number; admittedWorkloads?: number; reservingWorkloads?: number; flavorsUsage?: { name: string; resources: { name: string; total?: string; borrowed?: string }[] }[]; flavorsReservation?: { name: string; resources: { name: string; total?: string; borrowed?: string }[] }[]; conditions?: { type: string; status: string; reason?: string; message?: string }[]; fairSharing?: { weightedShare?: number } };
}
export interface LocalQueue { metadata: Meta; spec: { clusterQueue: string }; status?: { pendingWorkloads?: number; admittedWorkloads?: number; reservingWorkloads?: number; flavorUsage?: { name: string; resources: { name: string; total?: string }[] }[] } }
export interface ResourceFlavor { metadata: Meta; spec?: { nodeLabels?: Record<string, string>; nodeTaints?: unknown[] } }
export interface WorkloadPriorityClass { metadata: Meta; value: number; description?: string }
export interface Workload {
  metadata: Meta;
  spec: { queueName?: string; priorityClassName?: string; priority?: number; active?: boolean; podSets?: { name: string; count: number }[] };
  status?: { conditions?: { type: string; status: string; reason?: string; message?: string; lastTransitionTime?: string }[]; admission?: { clusterQueue?: string; podSetAssignments?: { name: string; flavors?: Record<string, string>; resourceUsage?: Record<string, string> }[] } };
}

export async function listClusterQueues(): Promise<ClusterQueue[]> {
  return (await k8sGetOrNull<K8sList<ClusterQueue>>('/apis/kueue.x-k8s.io/v1beta1/clusterqueues'))?.items ?? [];
}
export async function listLocalQueues(): Promise<LocalQueue[]> {
  return (await k8sGetOrNull<K8sList<LocalQueue>>('/apis/kueue.x-k8s.io/v1beta1/localqueues'))?.items ?? [];
}
export async function listResourceFlavors(): Promise<ResourceFlavor[]> {
  return (await k8sGetOrNull<K8sList<ResourceFlavor>>('/apis/kueue.x-k8s.io/v1beta1/resourceflavors'))?.items ?? [];
}
export async function listPriorityClasses(): Promise<WorkloadPriorityClass[]> {
  return (await k8sGetOrNull<K8sList<WorkloadPriorityClass>>('/apis/kueue.x-k8s.io/v1beta1/workloadpriorityclasses'))?.items ?? [];
}
export async function listWorkloads(namespace?: string): Promise<Workload[]> {
  const base = namespace ? `/apis/kueue.x-k8s.io/v1beta1/namespaces/${namespace}/workloads` : '/apis/kueue.x-k8s.io/v1beta1/workloads';
  return (await k8sGetOrNull<K8sList<Workload>>(base))?.items ?? [];
}
/** Kueue names Workloads `job-<jobname>-<hash>`; match by owner label when present. */
export async function workloadForJob(ns: string, jobName: string): Promise<Workload | undefined> {
  const items = (await k8sJson<K8sList<Workload>>(`/apis/kueue.x-k8s.io/v1beta1/namespaces/${ns}/workloads?labelSelector=${encodeURIComponent(`kueue.x-k8s.io/job-uid`)}`)).items;
  return items.find((w) => w.metadata.name.startsWith(`job-${jobName}-`));
}
export function workloadState(w: Workload | undefined): 'admitted' | 'pending' | 'evicted' | 'finished' | 'unknown' {
  if (!w) return 'unknown';
  const c = (t: string) => w.status?.conditions?.find((x) => x.type === t && x.status === 'True');
  if (c('Finished')) return 'finished';
  if (c('Evicted')) return 'evicted';
  if (c('Admitted')) return 'admitted';
  if (c('QuotaReserved')) return 'pending';
  return 'pending';
}
