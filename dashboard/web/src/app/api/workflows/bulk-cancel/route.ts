import { z } from 'zod';
import { body, route } from '@/server/api';
import { assertResourceAccess } from '@/server/auth/projects';
import { assertOwner } from '@/server/auth/session';
import { getRepo } from '@/server/store/repo';
import { TERMINAL_WF } from '@/server/store/types';
export const dynamic = 'force-dynamic';
export const POST = route('researcher', async ({ req, session }) => {
  const { ids } = await body(req, z.object({ ids: z.array(z.string()).min(1).max(50) }).strict());
  const workflows = await Promise.all([...new Set(ids)].map(async (id) => {
    const workflow = await getRepo().getWorkflow(id);
    await assertResourceAccess(session, workflow, 'workflow', true);
    assertOwner(session, workflow!.owner, 'workflow');
    return workflow!;
  }));
  const requested: string[] = [];
  const failed: string[] = [];
  for (const workflow of workflows) {
    if (TERMINAL_WF.has(workflow.status)) continue;
    try { await getRepo().requestCancellation(workflow.id, session.user, new Date().toISOString()); requested.push(workflow.id); }
    catch { failed.push(workflow.id); }
  }
  return { requested, failed };
}, { audit: 'workflow.bulk-cancel' });
