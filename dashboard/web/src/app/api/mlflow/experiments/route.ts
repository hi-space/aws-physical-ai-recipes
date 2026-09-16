import { route } from '@/server/api';
import { requestProject } from '@/server/auth/projects';
import { trackingAccess } from '@/server/services/tracking-access';
export const dynamic = 'force-dynamic';
export const GET = route('viewer', async ({ req, session }) =>
  trackingAccess().experiments(session, (await requestProject(req, session)).id));
