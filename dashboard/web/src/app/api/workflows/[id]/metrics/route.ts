import { qInt, route } from '@/server/api';
import { METRICS, queryRange } from '@/server/aws/amp';
import { getRepo } from '@/server/store/repo';
import { notFound } from '@/server/errors';
import { jobSetNameFor } from '@/server/workflow/compile';
export const dynamic = 'force-dynamic';
/** GPU / CPU / memory series for every pod of this workflow (pods are named wf-<id>-<task>-*). */
export const GET = route<{ id: string }>('viewer', async ({ params, url }) => {
  const wf = await getRepo().getWorkflow(params.id);
  if (!wf) throw notFound(`workflow ${params.id}`);
  const now = Math.floor(Date.now() / 1000);
  const end = wf.finishedAt ? Math.min(now, Math.floor(Date.parse(wf.finishedAt) / 1000) + 60) : now;
  const start = Math.max(end - 7 * 86400, wf.startedAt ? Math.floor(Date.parse(wf.startedAt) / 1000) - 60 : end - 3600);
  const step = Math.max(15, Math.ceil((end - start) / Math.max(50, Math.min(1000, qInt(url, 'points', 200)))));
  const tasks = await getRepo().listTasks(wf.id);
  const prefixes = [`wf-${params.id}-.*`];
  for (const group of wf.spec.workflow.groups ?? []) {
    const attempts = Math.max(1, ...tasks.filter((task) => task.groupId === group.name).map((task) => task.attempts));
    for (let attempt = 1; attempt <= attempts; attempt++) prefixes.push(`${jobSetNameFor(wf.id, group.name, attempt)}-.*`);
  }
  const p = { pod: prefixes.join('|'), namespace: wf.namespace };
  const queries = { gpuUtil: METRICS.gpu_util_pod(p), gpuMem: METRICS.gpu_mem_pod(p), cpu: METRICS.pod_cpu(p), mem: METRICS.pod_mem(p) };
  const results = await Promise.allSettled(Object.values(queries).map((query) => queryRange(query, start, end, step)));
  const series = Object.fromEntries(Object.keys(queries).map((name, index) => [name, results[index].status === 'fulfilled' ? results[index].value : []]));
  const errors = Object.fromEntries(Object.keys(queries).flatMap((name, index) => results[index].status === 'rejected' ? [[name, '지표 공급자에서 조회하지 못했습니다.']] : []));
  return { start, end, step, ...series, errors };
});
