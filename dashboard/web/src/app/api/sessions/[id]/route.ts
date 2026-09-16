import { route } from '@/server/api';
import { assertOwner } from '@/server/auth/session';
import { notFound } from '@/server/errors';
import { getRepo } from '@/server/store/repo';
import { deleteSession } from '@/server/services/sessions';
export const dynamic = 'force-dynamic';
export const DELETE = route<{ id: string }>('researcher', async ({ params, session }) => {
  const s = await getRepo().getSession(params.id);
  if (!s) throw notFound(`session ${params.id}`);
  assertOwner(session, s.owner, 'session');
  await deleteSession(params.id);
  return { ok: true };
}, { audit: 'session.delete' });
