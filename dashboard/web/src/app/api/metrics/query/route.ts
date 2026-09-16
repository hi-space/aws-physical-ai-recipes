import { z } from 'zod';
import { body, route } from '@/server/api';
import { queryInstant, queryRange } from '@/server/aws/amp';
import { badRequest } from '@/server/errors';
import { requestProject } from '@/server/auth/projects';
import { listLocalQueues } from '@/server/k8s/kueue';
import { scopedMetric } from '@/server/services/metrics';
export const dynamic = 'force-dynamic';
const schema = z.object({
  queries: z.array(z.object({ id: z.string(), metric: z.string(), params: z.record(z.string(), z.string()).default({}) })).min(1).max(12),
  range: z.object({ start: z.number(), end: z.number(), step: z.number().min(5).max(3600) }).optional(),
});
export const POST = route('viewer', async ({ req, session }) => {
  const b = await body(req, schema);
  if (b.range && (b.range.end <= b.range.start || b.range.end - b.range.start > 7 * 86400 || (b.range.end - b.range.start) / b.range.step > 11000)) throw badRequest('지표 기간은 최대 7일, 11,000개 샘플입니다.');
  const project = session.role === 'admin' && !session.tokenProjectId ? undefined : await requestProject(req, session);
  const clusterQueue = project && b.queries.some((query) => query.metric.startsWith('kueue_'))
    ? (await listLocalQueues()).find((queue) => queue.metadata.namespace === project.namespace && queue.metadata.name === project.queue)?.spec.clusterQueue : undefined;
  const queries = b.queries.map((query) => ({ id: query.id, promql: scopedMetric(query.metric, query.params, project, clusterQueue) }));
  const out: Record<string, unknown> = {};
  await Promise.all(
    queries.map(async ({ id, promql }) => {
      try {
        out[id] = b.range ? { promql, series: await queryRange(promql, b.range.start, b.range.end, b.range.step) } : { promql, instant: await queryInstant(promql) };
      } catch (e) {
        out[id] = { promql, error: (e as Error).message };
      }
    }),
  );
  return out;
});
