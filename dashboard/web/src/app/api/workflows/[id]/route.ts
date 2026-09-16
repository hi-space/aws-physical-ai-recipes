import { route } from '@/server/api';
import { notFound } from '@/server/errors';
import { assertOwner } from '@/server/auth/session';
import { getRepo } from '@/server/store/repo';
import { deleteWorkflow, realDeps, reconcileWorkflow } from '@/server/workflow/controller';
import { TERMINAL_WF } from '@/server/store/types';
export const dynamic = 'force-dynamic';

export const GET = route<{ id: string }>('viewer', async ({ params }) => {
  const repo = getRepo();
  let wf = await repo.getWorkflow(params.id);
  if (!wf) throw notFound(`workflow ${params.id}`);
  // On-demand reconcile so the detail page is fresh even between controller ticks.
  if (!TERMINAL_WF.has(wf.status)) wf = await reconcileWorkflow(wf, realDeps()).catch(() => wf!);
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
