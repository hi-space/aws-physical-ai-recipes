import { route } from '@/server/api';
import { SYSTEM_NAMESPACES } from '@/server/k8s/client';
import { deleteJob, getJob } from '@/server/k8s/resources';
import { forbidden, notFound } from '@/server/errors';
export const dynamic = 'force-dynamic';

function assertUserNamespace(ns: string) {
  if (SYSTEM_NAMESPACES.has(ns)) throw forbidden(`namespace ${ns} is reserved`);
}

export const GET = route<{ ns: string; name: string }>('viewer', async ({ params }) => {
  assertUserNamespace(params.ns);
  const j = await getJob(params.ns, params.name);
  if (!j) throw notFound('job');
  return j;
});
export const DELETE = route<{ ns: string; name: string }>('researcher', async ({ params }) => {
  assertUserNamespace(params.ns);
  await deleteJob(params.ns, params.name); // deleteJob also enforces assertWritableNamespace at the sink
  return { ok: true };
}, { audit: 'k8s.job.delete' });
