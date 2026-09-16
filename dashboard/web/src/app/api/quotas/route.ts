import { z } from 'zod';
import { body, q, route } from '@/server/api';
import { backendConfig as config } from '@/server/backends/context';
import * as hp from '@/server/aws/hyperpod';
import { notConfigured } from '@/server/errors';
export const dynamic = 'force-dynamic';

async function eksArn(): Promise<string> {
  const name = config().eks?.hyperPodClusterName;
  if (!name) throw notConfigured('HyperPod EKS');
  return (await hp.describeCluster(name)).ClusterArn!;
}
export const GET = route('viewer', async () => {
  const arn = await eksArn();
  const [quotas, policies] = await Promise.all([hp.listComputeQuotas(arn), hp.listSchedulerConfigs(arn)]);
  return { clusterArn: arn, quotas, policies };
});
const createSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('quota'), name: z.string().min(1).max(63), team: z.string().min(1).max(40), fairShareWeight: z.number().int().min(0).max(100).optional(), instances: z.array(z.object({ instanceType: z.string(), count: z.number().int().min(0) })).min(1), borrowLimit: z.number().int().min(0).max(500).optional(), preempt: z.enum(['LowerPriority', 'Never']).optional(), description: z.string().optional() }),
  z.object({ kind: z.literal('policy'), name: z.string().min(1).max(63), priorityClasses: z.array(z.object({ name: z.string(), weight: z.number().int().min(0).max(100) })).min(1), fairShare: z.boolean().default(true) }),
]);
export const POST = route('admin', async ({ req }) => {
  const b = await body(req, createSchema);
  const arn = await eksArn();
  if (b.kind === 'quota') return hp.createComputeQuota({ ...b, clusterArn: arn });
  return hp.createSchedulerConfig(b.name, arn, b.priorityClasses, b.fairShare);
}, { audit: 'quota.create' });
export const DELETE = route('admin', async ({ url }) => {
  const id = q(url, 'id');
  const kind = q(url, 'kind') ?? 'quota';
  if (!id) throw new Error('id required');
  if (kind === 'policy') await hp.deleteSchedulerConfig(id);
  else await hp.deleteComputeQuota(id);
  return { ok: true };
}, { audit: 'quota.delete' });
