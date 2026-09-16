import { z } from 'zod';
import { body, route } from '@/server/api';
import { knownClusters } from '@/server/services/compute';
import { notFound } from '@/server/errors';
import { executeScalePlan, scaleSnapshot } from '@/server/services/scaling-plans';
export const dynamic = 'force-dynamic';
export const GET = route<{ name: string }>('admin', async ({ params, url }) => {
  if (!knownClusters().some(c => c.name === params.name)) throw notFound('cluster');
  const group = z.string().min(1).max(63).parse(url.searchParams.get('group'));
  return scaleSnapshot(params.name, group);
});
export const POST = route<{ name: string }>('admin', async ({ params, req, session }) => {
  if (!knownClusters().some((c) => c.name === params.name)) throw notFound(`cluster ${params.name}`);
  const b = await body(req, z.object({ planId: z.string().uuid() }).strict());
  return executeScalePlan(params.name, b.planId, session.subject ?? session.user);
}, { audit: 'cluster.scale' });
