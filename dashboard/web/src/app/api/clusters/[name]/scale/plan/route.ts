import { body, route } from '@/server/api';
import { knownClusters } from '@/server/services/compute';
import { notFound } from '@/server/errors';
import { planScale, scalePlanInput } from '@/server/services/scaling-plans';
export const dynamic = 'force-dynamic';
export const POST = route<{ name: string }>('admin', async ({ req, session, params }) => {
  if (!knownClusters().some(c => c.name === params.name)) throw notFound('cluster');
  return planScale(params.name, await body(req, scalePlanInput), session.subject ?? session.user);
}, { audit: 'cluster.scale.plan' });
