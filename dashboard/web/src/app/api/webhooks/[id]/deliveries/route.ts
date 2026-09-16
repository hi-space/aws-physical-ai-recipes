import { route } from '@/server/api';
import { requestProject } from '@/server/auth/projects';
import { webhooksService } from '@/server/services/webhooks';
export const dynamic = 'force-dynamic';
export const GET = route<{ id: string }>('viewer', async ({ req, session, params }) =>
  webhooksService(session).deliveries(params.id, await requestProject(req, session)));
