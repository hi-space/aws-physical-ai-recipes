import { route } from '@/server/api';
import { deleteSession } from '@/server/services/sessions';
export const dynamic = 'force-dynamic';
export const DELETE = route<{ id: string }>('researcher', async ({ params }) => {
  await deleteSession(params.id);
  return { ok: true };
}, { audit: 'session.delete' });
