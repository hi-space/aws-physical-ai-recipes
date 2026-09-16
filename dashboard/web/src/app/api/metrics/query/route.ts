import { z } from 'zod';
import { body, route } from '@/server/api';
import { METRICS, queryInstant, queryRange } from '@/server/aws/amp';
import { badRequest } from '@/server/errors';
export const dynamic = 'force-dynamic';
const schema = z.object({
  queries: z.array(z.object({ id: z.string(), metric: z.string(), params: z.record(z.string(), z.string()).default({}) })).min(1).max(12),
  range: z.object({ start: z.number(), end: z.number(), step: z.number().min(5).max(3600) }).optional(),
});
export const POST = route('viewer', async ({ req }) => {
  const b = await body(req, schema);
  const out: Record<string, unknown> = {};
  await Promise.all(
    b.queries.map(async (qq) => {
      const build = METRICS[qq.metric];
      if (!build) throw badRequest(`unknown metric ${qq.metric}`);
      const promql = build(qq.params);
      try {
        out[qq.id] = b.range ? { promql, series: await queryRange(promql, b.range.start, b.range.end, b.range.step) } : { promql, instant: await queryInstant(promql) };
      } catch (e) {
        out[qq.id] = { promql, error: (e as Error).message };
      }
    }),
  );
  return out;
});
