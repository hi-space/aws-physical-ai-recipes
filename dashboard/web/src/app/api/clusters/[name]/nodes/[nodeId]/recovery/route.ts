import { z } from 'zod';
import { route, body, q } from '@/server/api';
import { describeCluster } from '@/server/aws/hyperpod';
import { planNodeRecovery, executeNodeRecovery } from '@/server/services/node-recovery';
import { backendConfig } from '@/server/backends/context';
import { badRequest, notFound } from '@/server/errors';

type Params = { name: string; nodeId: string };

// GET: fetch the recovery plan
export const GET = route<Params>('admin', async ({ params, url }) => {
  const action = q(url, 'action');
  if (action !== 'reboot' && action !== 'replace') throw badRequest('action must be "reboot" or "replace"');

  // Verify cluster param equals configured hyperPodClusterName
  const config = backendConfig();
  if (!config.eks || params.name !== config.eks.hyperPodClusterName) {
    throw notFound(`Cluster ${params.name} not found`);
  }

  const cluster = await describeCluster(params.name);
  const plan = await planNodeRecovery(cluster, params.nodeId, action);

  return { plan };
});

// POST: execute the recovery
const ExecuteSchema = z.object({
  action: z.enum(['reboot', 'replace']),
  token: z.string(),
  acknowledgeRunningPods: z.boolean().default(false),
});

export const POST = route<Params>('admin', async ({ params, req }) => {
  const { action, token, acknowledgeRunningPods } = await body(req, ExecuteSchema);

  // Verify cluster param equals configured hyperPodClusterName
  const config = backendConfig();
  if (!config.eks || params.name !== config.eks.hyperPodClusterName) {
    throw notFound(`Cluster ${params.name} not found`);
  }

  const cluster = await describeCluster(params.name);
  const result = await executeNodeRecovery(cluster, params.nodeId, action, token, acknowledgeRunningPods);

  return result;
}, { audit: 'node.recovery' });
