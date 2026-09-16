import { q, route } from '@/server/api';
import { getRepo } from '@/server/store/repo';
import { forbidden, notFound } from '@/server/errors';
import { canReadResource, filterAccessible } from '@/server/auth/projects';
import { assertDatasetOwner } from '@/server/services/datasets';
import { deleteDataset, lineage } from '@/server/services/datasets';
export const dynamic = 'force-dynamic';
export const GET = route<{ name: string }>('viewer', async ({ params, session }) => {
  const repo = getRepo();
  const ds = await repo.getDataset(params.name);
  if (!ds) throw notFound(`dataset ${params.name}`);
  const [versions, lin] = await Promise.all([repo.listVersions(params.name), lineage(params.name)]);
  const consumers=await filterAccessible(session,lin.consumers);
  const produced=[];
  for(const producer of lin.produced){const wf=await repo.getWorkflow(producer.workflowId);if(wf && await canReadResource(session,wf,repo))produced.push(producer);}
  return { dataset: ds, versions: versions.filter(v => (v.projectId ?? '') === (ds.projectId ?? '')), lineage: {produced,consumers} };
});
export const DELETE = route<{ name: string }>('researcher', async ({ params, url, session }) => {
  const ds = await getRepo().getDataset(params.name);
  if (!ds) throw notFound(`dataset ${params.name}`);
  await assertDatasetOwner(session, params.name);
  const purge = q(url, 'purge') === '1';
  if (purge && session.role !== 'admin') throw forbidden('purging S3 objects requires the admin role');
  await deleteDataset(params.name, purge);
  return { ok: true };
}, { audit: 'dataset.delete' });
