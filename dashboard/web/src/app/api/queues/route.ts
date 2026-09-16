import { route } from '@/server/api';
import { listClusterQueues, listLocalQueues, listPriorityClasses, listResourceFlavors, listWorkloads, workloadState } from '@/server/k8s/kueue';
import { SYSTEM_NAMESPACES } from '@/server/k8s/client';
import { requestProject } from '@/server/auth/projects';
export const dynamic = 'force-dynamic';
export const GET = route('viewer', async ({ req, session }) => {
  const project = session.role === 'admin' ? undefined : await requestProject(req, session);
  const [allCqs, allLqs, allFlavors, prio, wls] = await Promise.all([listClusterQueues(), listLocalQueues(), listResourceFlavors(), listPriorityClasses(), listWorkloads(project?.namespace)]);
  const lqs = project ? allLqs.filter((queue) => queue.metadata.namespace === project.namespace && queue.metadata.name === project.queue) : allLqs;
  const allowedQueues = new Set(lqs.map((queue) => queue.spec.clusterQueue));
  const cqs = project ? allCqs.filter((queue) => allowedQueues.has(queue.metadata.name)) : allCqs;
  const allowedFlavors = new Set(cqs.flatMap((queue) => (queue.spec.resourceGroups ?? []).flatMap((group) => group.flavors.map((flavor) => flavor.name))));
  const flavors = project ? allFlavors.filter((flavor) => allowedFlavors.has(flavor.metadata.name)) : allFlavors;
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
    workloads: wls.filter((w) => !SYSTEM_NAMESPACES.has(w.metadata.namespace ?? '') && (!project || (w.metadata.namespace === project.namespace && w.spec.queueName === project.queue))).map((w) => ({
      name: w.metadata.name, namespace: w.metadata.namespace, queue: w.spec.queueName, priorityClass: w.spec.priorityClassName, priority: w.spec.priority, state: workloadState(w),
      clusterQueue: w.status?.admission?.clusterQueue, created: w.metadata.creationTimestamp, active: w.spec.active !== false,
      message: w.status?.conditions?.filter((c) => c.status === 'True').map((c) => `${c.type}${c.reason ? ` (${c.reason})` : ''}${c.message ? `: ${c.message}` : ''}`).slice(-1)[0],
      podSets: w.spec.podSets?.map((set) => ({ name: set.name, count: set.count })), usage: w.status?.admission?.podSetAssignments?.flatMap((a) => Object.entries(a.resourceUsage ?? {}).map(([k, v]) => `${k}=${v}`)),
    })).sort((a, b) => (b.created ?? '').localeCompare(a.created ?? '')),
  };
});
