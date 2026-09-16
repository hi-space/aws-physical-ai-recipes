import { z } from 'zod';
import { body, route } from '@/server/api';
import { knownClusters } from '@/server/services/compute';
import { notFound } from '@/server/errors';
import { reconcileScale } from '@/server/services/scaling-plans';
export const dynamic = 'force-dynamic';
export const POST = route<{ name: string }>('admin', async ({ req, params }) => {
  if (!knownClusters().some(c => c.name === params.name)) throw notFound('cluster');
  const input = await body(req, z.object({ operationId: z.string().uuid() }).strict());
  return reconcileScale(params.name, input.operationId);
}, { audit: 'cluster.scale.reconcile' });
