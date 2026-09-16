import { body, route } from '@/server/api';
import { requestProject } from '@/server/auth/projects';
import { webhookUpdateSchema, webhooksService } from '@/server/services/webhooks';
export const dynamic = 'force-dynamic';
export const GET = route<{ id: string }>('viewer', async ({ req, session, params }) =>
  webhooksService(session).get(params.id, await requestProject(req, session)));
export const PATCH = route<{ id: string }>('researcher', async ({ req, session, params }) =>
  webhooksService(session).update(params.id, await body(req, webhookUpdateSchema), await requestProject(req, session, 'project-admin')),
{ audit: 'webhook.update' });
/** Soft disable: encrypted configuration and event/delivery history are retained. */
export const DELETE = route<{ id: string }>('researcher', async ({ req, session, params }) =>
  webhooksService(session).update(params.id, { enabled: false }, await requestProject(req, session, 'project-admin')),
{ audit: 'webhook.disable' });
