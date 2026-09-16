import { route } from '@/server/api';
import { assertOwner } from '@/server/auth/session';
import { notFound } from '@/server/errors';
import { getRepo } from '@/server/store/repo';
import { cancelWorkflow } from '@/server/workflow/controller';
export const dynamic = 'force-dynamic';
export const POST = route<{ id: string }>('researcher', async ({ params, session }) => {
  const wf = await getRepo().getWorkflow(params.id);
  if (!wf) throw notFound(`workflow ${params.id}`);
  assertOwner(session, wf.owner, 'workflow');
  return cancelWorkflow(params.id, session.user);
}, { audit: 'workflow.cancel' });
