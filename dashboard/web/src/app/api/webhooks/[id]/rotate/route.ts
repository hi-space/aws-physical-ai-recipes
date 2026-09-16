import { body, route } from '@/server/api';
import { requestProject } from '@/server/auth/projects';
import { webhookRotateSchema, webhooksService } from '@/server/services/webhooks';
export const dynamic = 'force-dynamic';
export const POST = route<{ id: string }>('researcher', async ({ req, session, params }) =>
  webhooksService(session).rotate(params.id, await body(req, webhookRotateSchema), await requestProject(req, session, 'project-admin')),
{ audit: 'webhook.rotate' });
