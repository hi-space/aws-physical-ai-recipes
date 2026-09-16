import { q, route } from '@/server/api';
import { getRepo } from '@/server/store/repo';
import { notFound } from '@/server/errors';
import { deleteDataset, lineage } from '@/server/services/datasets';
export const dynamic = 'force-dynamic';
export const GET = route<{ name: string }>('viewer', async ({ params }) => {
  const repo = getRepo();
  const ds = await repo.getDataset(params.name);
  if (!ds) throw notFound(`dataset ${params.name}`);
  const [versions, lin] = await Promise.all([repo.listVersions(params.name), lineage(params.name)]);
  return { dataset: ds, versions, lineage: lin };
});
export const DELETE = route<{ name: string }>('researcher', async ({ params, url }) => {
  await deleteDataset(params.name, q(url, 'purge') === '1');
  return { ok: true };
}, { audit: 'dataset.delete' });
