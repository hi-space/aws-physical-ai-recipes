import { route } from '@/server/api';
import { notFound } from '@/server/errors';
import { assertOwner } from '@/server/auth/session';
import { getRepo } from '@/server/store/repo';
import { deleteWorkflow } from '@/server/workflow/controller';
export const dynamic = 'force-dynamic';

export const GET = route<{ id: string }>('viewer', async ({ params }) => {
  const repo = getRepo();
  const wf = await repo.getWorkflow(params.id);
  if (!wf) throw notFound(`workflow ${params.id}`);
  const tasks = await repo.listTasks(params.id);
  return { workflow: wf, tasks };
});

export const DELETE = route<{ id: string }>('researcher', async ({ params, session }) => {
  const wf = await getRepo().getWorkflow(params.id);
  if (!wf) throw notFound(`workflow ${params.id}`);
  assertOwner(session, wf.owner, 'workflow');
  await deleteWorkflow(params.id);
  return { ok: true };
}, { audit: 'workflow.delete' });
