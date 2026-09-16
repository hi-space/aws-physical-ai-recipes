import { route } from '@/server/api';
import { launchDcvBrowserSession, closeDcvBrowserSession } from '@/server/dcv/sessions';
export const dynamic = 'force-dynamic';
export const POST = route<{ id: string }>('admin', async ({ params, session }) => launchDcvBrowserSession(params.id, session), { audit: 'dcv.launch' });
export const DELETE = route<{ id: string }>('admin', async ({ params, session }) => {
  await closeDcvBrowserSession(params.id, session); return { status: 'CLOSED' };
}, { audit: 'dcv.close' });
