import { body, route } from '@/server/api';
import { isProjectAdmin, requestProject } from '@/server/auth/projects';
import { webhookInputSchema, webhooksService } from '@/server/services/webhooks';
export const dynamic = 'force-dynamic';
export const GET = route('viewer', async ({ req, session }) => {
  const project = await requestProject(req, session);
  return { project: { id: project.id, name: project.name }, hooks: await webhooksService(session).list(project),
    canManage: session.authMethod !== 'token' && !session.tokenProjectId &&
      (session.role === 'admin' || session.role === 'researcher' && isProjectAdmin(session, project)) };
});
export const POST = route('researcher', async ({ req, session }) =>
  webhooksService(session).create(await body(req, webhookInputSchema), await requestProject(req, session, 'project-admin')),
{ audit: 'webhook.create' });
