import { z } from 'zod';
import { body, route } from '@/server/api';
import { knownClusters } from '@/server/services/compute';
import { notFound } from '@/server/errors';
import { scaleChecked } from '@/server/services/scaling';
export const dynamic = 'force-dynamic';
export const POST = route<{ name: string }>('admin', async ({ params, req }) => {
  if (!knownClusters().some((c) => c.name === params.name)) throw notFound(`cluster ${params.name}`);
  const b = await body(req, z.object({ group: z.string().min(1), count: z.number().int().min(0).max(64), expectedCount: z.number().int().min(0).max(64) }));
  await scaleChecked(params.name, b.group, b.count, b.expectedCount);
  return { ok: true, ...b };
}, { audit: 'cluster.scale' });
