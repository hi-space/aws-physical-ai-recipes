import { route } from '@/server/api';
import { launchSession } from '@/server/services/sessions';
export const dynamic = 'force-dynamic';
export const POST = route<{ id: string }>('researcher', async ({ params, session }) =>
  launchSession(params.id, session), { audit: 'session.launch' });
