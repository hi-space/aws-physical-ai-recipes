import { qInt, route } from '@/server/api';
import { METRICS, queryRange } from '@/server/aws/amp';
import { getRepo } from '@/server/store/repo';
import { notFound } from '@/server/errors';
export const dynamic = 'force-dynamic';
/** GPU / CPU / memory series for every pod of this workflow (pods are named wf-<id>-<task>-*). */
export const GET = route<{ id: string }>('viewer', async ({ params, url }) => {
  const wf = await getRepo().getWorkflow(params.id);
  if (!wf) throw notFound(`workflow ${params.id}`);
  const end = Math.floor(Date.now() / 1000);
  const start = wf.startedAt ? Math.floor(new Date(wf.startedAt).getTime() / 1000) - 60 : end - 3600;
  const step = Math.max(15, Math.floor((end - start) / qInt(url, 'points', 200)));
  const p = { pod: `wf-${params.id}-.*`, namespace: wf.namespace };
  const [gpuUtil, gpuMem, cpu, mem] = await Promise.all([
    queryRange(METRICS.gpu_util_pod(p), start, end, step).catch(() => []),
    queryRange(METRICS.gpu_mem_pod(p), start, end, step).catch(() => []),
    queryRange(METRICS.pod_cpu(p), start, end, step).catch(() => []),
    queryRange(METRICS.pod_mem(p), start, end, step).catch(() => []),
  ]);
  return { start, end, step, gpuUtil, gpuMem, cpu, mem };
});
