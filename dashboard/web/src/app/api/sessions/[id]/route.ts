import { body, route } from '@/server/api';
import { deleteSession, extendSession, extendSessionSchema, publicSession } from '@/server/services/sessions';
export const dynamic = 'force-dynamic';
export const DELETE = route<{ id: string }>('viewer', async ({ params, session }) =>
  publicSession(await deleteSession(params.id, session), session), { audit: 'session.end' });
export const PATCH = route<{ id: string }>('researcher', async ({ req, params, session }) => {
  const input = await body(req, extendSessionSchema);
  return publicSession(await extendSession(params.id, input.ttlMinutes, session), session);
}, { audit: 'session.extend' });
