import { route } from '@/server/api';
import { listClusterQueues, listLocalQueues, listPriorityClasses, listResourceFlavors, listWorkloads, workloadState } from '@/server/k8s/kueue';
import { SYSTEM_NAMESPACES } from '@/server/k8s/client';
export const dynamic = 'force-dynamic';
export const GET = route('viewer', async () => {
  const [cqs, lqs, flavors, prio, wls] = await Promise.all([listClusterQueues(), listLocalQueues(), listResourceFlavors(), listPriorityClasses(), listWorkloads()]);
  return {
    clusterQueues: cqs.map((q) => ({
      name: q.metadata.name, cohort: q.spec.cohort, pending: q.status?.pendingWorkloads ?? 0, admitted: q.status?.admittedWorkloads ?? 0, reserving: q.status?.reservingWorkloads ?? 0,
      preemption: q.spec.preemption, fairShareWeight: q.spec.fairSharing?.weight, weightedShare: q.status?.fairSharing?.weightedShare,
      quotas: (q.spec.resourceGroups ?? []).flatMap((g) => g.flavors.flatMap((f) => f.resources.map((r) => ({ flavor: f.name, resource: r.name, nominal: r.nominalQuota, borrowingLimit: r.borrowingLimit, lendingLimit: r.lendingLimit })))),
      usage: (q.status?.flavorsUsage ?? []).flatMap((f) => f.resources.map((r) => ({ flavor: f.name, resource: r.name, total: r.total, borrowed: r.borrowed }))),
      conditions: q.status?.conditions ?? [],
    })),
    localQueues: lqs.map((q) => ({ name: q.metadata.name, namespace: q.metadata.namespace, clusterQueue: q.spec.clusterQueue, pending: q.status?.pendingWorkloads ?? 0, admitted: q.status?.admittedWorkloads ?? 0 })),
    flavors: flavors.map((f) => ({ name: f.metadata.name, nodeLabels: f.spec?.nodeLabels ?? {} })),
    priorityClasses: prio.map((p) => ({ name: p.metadata.name, value: p.value, description: p.description })).sort((a, b) => b.value - a.value),
    workloads: wls.filter((w) => !SYSTEM_NAMESPACES.has(w.metadata.namespace ?? '')).map((w) => ({
      name: w.metadata.name, namespace: w.metadata.namespace, queue: w.spec.queueName, priorityClass: w.spec.priorityClassName, priority: w.spec.priority, state: workloadState(w),
      clusterQueue: w.status?.admission?.clusterQueue, created: w.metadata.creationTimestamp, active: w.spec.active !== false,
      message: w.status?.conditions?.filter((c) => c.status === 'True').map((c) => `${c.type}${c.reason ? ` (${c.reason})` : ''}${c.message ? `: ${c.message}` : ''}`).slice(-1)[0],
      podSets: w.spec.podSets, usage: w.status?.admission?.podSetAssignments?.flatMap((a) => Object.entries(a.resourceUsage ?? {}).map(([k, v]) => `${k}=${v}`)),
    })).sort((a, b) => (b.created ?? '').localeCompare(a.created ?? '')),
  };
});
