import { q, route } from '@/server/api';
import { getRepo } from '@/server/store/repo';
import { forbidden, notFound } from '@/server/errors';
import { assertOwner } from '@/server/auth/session';
import { deleteDataset, lineage } from '@/server/services/datasets';
export const dynamic = 'force-dynamic';
export const GET = route<{ name: string }>('viewer', async ({ params }) => {
  const repo = getRepo();
  const ds = await repo.getDataset(params.name);
  if (!ds) throw notFound(`dataset ${params.name}`);
  const [versions, lin] = await Promise.all([repo.listVersions(params.name), lineage(params.name)]);
  return { dataset: ds, versions, lineage: lin };
});
export const DELETE = route<{ name: string }>('researcher', async ({ params, url, session }) => {
  const ds = await getRepo().getDataset(params.name);
  if (!ds) throw notFound(`dataset ${params.name}`);
  assertOwner(session, ds.owner, 'dataset');
  const purge = q(url, 'purge') === '1';
  if (purge && session.role !== 'admin') throw forbidden('purging S3 objects requires the admin role');
  await deleteDataset(params.name, purge);
  return { ok: true };
}, { audit: 'dataset.delete' });
