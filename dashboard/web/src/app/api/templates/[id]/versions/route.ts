import { route } from '@/server/api';
import { notFound } from '@/server/errors';
import { getRepo } from '@/server/store/repo';
import { canReadTemplate, ensureBuiltin } from '../../_shared';
export const dynamic = 'force-dynamic';
export const GET = route<{ id: string }>('viewer', async ({ params, session }) => {
  const repo = getRepo();
  await ensureBuiltin(params.id, repo);
  const head = await repo.getTemplate(params.id, undefined, { includeDeleted: true });
  if (!await canReadTemplate(session, head, repo)) throw notFound('template');
  return repo.listTemplateVersions(params.id);
});
