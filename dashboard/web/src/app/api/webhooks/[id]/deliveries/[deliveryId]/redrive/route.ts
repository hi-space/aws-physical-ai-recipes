import { z } from 'zod';
import { body, route } from '@/server/api';
import { requestProject } from '@/server/auth/projects';
import { webhooksService } from '@/server/services/webhooks';
export const dynamic = 'force-dynamic';
export const POST = route<{ id: string; deliveryId: string }>('researcher', async ({ req, session, params }) => {
  await body(req, z.object({}).strict());
  return webhooksService(session).redrive(params.id, params.deliveryId, await requestProject(req, session, 'project-admin'));
}, { audit: 'webhook.redrive' });
