import { body, route } from '@/server/api';
import { requestProject } from '@/server/auth/projects';
import { modelsService, registrationSchema } from '@/server/services/models';
export const dynamic = 'force-dynamic';

export const GET = route('viewer', async ({ req, session, url }) => {
  const project = await requestProject(req, session);
  return modelsService().list(session, project.id, url.searchParams.get('cursor') ?? undefined);
});
export const POST = route('researcher', async ({ req, session }) => {
  const project = await requestProject(req, session, 'researcher');
  return modelsService().register(session, project.id, await body(req, registrationSchema));
}, { audit: 'model.register-published-checkpoint' });
