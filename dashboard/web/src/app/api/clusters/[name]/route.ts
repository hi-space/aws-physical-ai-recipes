import { route } from '@/server/api';
import { knownClusters, summarizeCluster } from '@/server/services/compute';
import { notFound } from '@/server/errors';
import * as hp from '@/server/aws/hyperpod';
export const dynamic = 'force-dynamic';
export const GET = route<{ name: string }>('viewer', async ({ params }) => {
  const k = knownClusters().find((c) => c.name === params.name);
  if (!k) throw notFound(`cluster ${params.name}`);
  const [summary, events] = await Promise.all([summarizeCluster(k.name, k.orchestrator), hp.listEvents(k.name).catch(() => [])]);
  return { ...summary, events };
});
