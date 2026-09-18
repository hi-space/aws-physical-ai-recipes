import { z } from 'zod';
import { body, q, route } from '@/server/api';
import { backendConfig } from '@/server/backends/context';
import { describeCluster } from '@/server/aws/hyperpod';
import { badRequest, notFound } from '@/server/errors';
import { executeNodeRecovery, planNodeRecovery } from '@/server/services/node-recovery';
import { knownClusters } from '@/server/services/compute';

type Params = { name: string; nodeId: string };
export const dynamic = 'force-dynamic';

function assertKnownCluster(name: string) {
  backendConfig();
  if (!knownClusters().some((c) => c.name === name)) throw notFound(`cluster ${name}`);
}
const actionOf = (value?: string) => {
  if (value !== 'reboot' && value !== 'replace') throw badRequest('action must be "reboot" or "replace"');
  return value;
};

/** Plan: DescribeClusterNode + (EKS) Kubernetes node and pods. Admin only; nothing is changed. */
export const GET = route<Params>('admin', async ({ params, url }) => {
  assertKnownCluster(params.name);
  const action = actionOf(q(url, 'action'));
  return { plan: await planNodeRecovery(await describeCluster(params.name), params.nodeId, action) };
});

const ExecuteSchema = z.object({ action: z.enum(['reboot', 'replace']), token: z.string().min(1), acknowledgeRunningPods: z.boolean().default(false) });
/** Execute: re-plans, compares the token, then calls BatchReboot/ReplaceClusterNodes for this one instance. */
export const POST = route<Params>('admin', async ({ params, req }) => {
  assertKnownCluster(params.name);
  const { action, token, acknowledgeRunningPods } = await body(req, ExecuteSchema);
  return executeNodeRecovery(await describeCluster(params.name), params.nodeId, action, token, acknowledgeRunningPods);
}, { audit: 'node.recovery' });
