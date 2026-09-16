import { route } from '@/server/api';
import { deleteJob, getJob } from '@/server/k8s/resources';
import { notFound } from '@/server/errors';
export const dynamic = 'force-dynamic';
export const GET = route<{ ns: string; name: string }>('viewer', async ({ params }) => {
  const j = await getJob(params.ns, params.name);
  if (!j) throw notFound('job');
  return j;
});
export const DELETE = route<{ ns: string; name: string }>('researcher', async ({ params }) => {
  await deleteJob(params.ns, params.name);
  return { ok: true };
}, { audit: 'k8s.job.delete' });
