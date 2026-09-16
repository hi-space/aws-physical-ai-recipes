import { q, route } from '@/server/api';
import { requestProject } from '@/server/auth/projects';
import { trackingAccess } from '@/server/services/tracking-access';
export const dynamic = 'force-dynamic';
export const GET = route<{ id: string }>('viewer', async ({ req, session, params, url }) =>
  trackingAccess().history(session, (await requestProject(req, session)).id, params.id, (q(url, 'key') ?? '').split(',')));
