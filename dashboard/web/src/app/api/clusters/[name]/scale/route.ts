import { z } from 'zod';
import { body, route } from '@/server/api';
import { knownClusters } from '@/server/services/compute';
import { notFound } from '@/server/errors';
import * as hp from '@/server/aws/hyperpod';
export const dynamic = 'force-dynamic';
export const POST = route<{ name: string }>('admin', async ({ params, req }) => {
  if (!knownClusters().some((c) => c.name === params.name)) throw notFound(`cluster ${params.name}`);
  const b = await body(req, z.object({ group: z.string().min(1), count: z.number().int().min(0).max(64) }));
  await hp.scaleGroup(params.name, b.group, b.count);
  return { ok: true, ...b };
}, { audit: 'cluster.scale' });
