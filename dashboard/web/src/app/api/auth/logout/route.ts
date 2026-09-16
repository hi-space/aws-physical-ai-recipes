import { route } from '@/server/api';
import { getRepo } from '@/server/store/repo';
export const dynamic = 'force-dynamic';
export const POST = route('viewer', async ({ session }) => {
  for (const current of await getRepo().listSessions()) {
    if (current.ownerSubject === session.subject) await getRepo().putSession({ ...current, revokedAt: new Date().toISOString() });
  }
  return { url: '/api/logout' };
}, { audit: 'auth.logout' });
