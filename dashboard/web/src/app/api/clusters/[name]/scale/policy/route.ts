import { body, route } from '@/server/api';
import { knownClusters } from '@/server/services/compute';
import { notFound } from '@/server/errors';
import { policyInput, saveScalingPolicy } from '@/server/services/scaling-plans';
export const dynamic = 'force-dynamic';
export const PUT = route<{ name: string }>('admin', async ({ req, session, params }) => {
  if (!knownClusters().some(c => c.name === params.name)) throw notFound('cluster');
  return saveScalingPolicy(params.name, await body(req, policyInput), session.subject ?? session.user);
}, { audit: 'cluster.scale.policy' });
