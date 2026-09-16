import { q, route } from '@/server/api';
import { SYSTEM_NAMESPACES } from '@/server/k8s/client';
import { listJobs, listPods } from '@/server/k8s/resources';
export const dynamic = 'force-dynamic';
export const GET = route('viewer', async ({ url }) => {
  const ns = q(url, 'ns');
  const [jobs, pods] = await Promise.all([listJobs(ns), listPods(ns)]);
  const podsByJob = new Map<string, typeof pods>();
  for (const p of pods) {
    const j = p.metadata.labels?.['job-name'];
    if (j) podsByJob.set(`${p.metadata.namespace}/${j}`, [...(podsByJob.get(`${p.metadata.namespace}/${j}`) ?? []), p]);
  }
  return jobs
    .filter((j) => !SYSTEM_NAMESPACES.has(j.metadata.namespace ?? ''))
    .map((j) => {
      const ps = podsByJob.get(`${j.metadata.namespace}/${j.metadata.name}`) ?? [];
      const cond = j.status?.conditions?.find((c) => c.status === 'True');
      return {
        name: j.metadata.name,
        namespace: j.metadata.namespace,
        created: j.metadata.creationTimestamp,
        startTime: j.status?.startTime,
        completionTime: j.status?.completionTime,
        active: j.status?.active ?? 0,
        succeeded: j.status?.succeeded ?? 0,
        failed: j.status?.failed ?? 0,
        completions: j.spec.completions ?? 1,
        suspended: Boolean(j.spec.suspend),
        state: cond?.type ?? (j.status?.active ? 'Running' : ps.length ? ps[0].status?.phase ?? 'Pending' : 'Pending'),
        queue: j.metadata.labels?.['kueue.x-k8s.io/queue-name'],
        priority: j.metadata.labels?.['kueue.x-k8s.io/priority-class'],
        workflowId: j.metadata.labels?.['pai.aws/workflow-id'],
        task: j.metadata.labels?.['pai.aws/task'],
        app: j.metadata.labels?.app,
        image: j.spec.template.spec.containers[0]?.image,
        nodeSelector: j.spec.template.spec.nodeSelector,
        gpu: j.spec.template.spec.containers[0]?.resources?.limits?.['nvidia.com/gpu'],
        pods: ps.map((p) => ({ name: p.metadata.name, phase: p.status?.phase, node: p.spec.nodeName, started: p.status?.startTime, restarts: p.status?.containerStatuses?.[0]?.restartCount ?? 0 })),
      };
    })
    .sort((a, b) => (b.created ?? '').localeCompare(a.created ?? ''));
});
