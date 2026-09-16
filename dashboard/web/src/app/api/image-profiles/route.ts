import { body, route } from '@/server/api';
import { requestProject } from '@/server/auth/projects';
import { imageProfileInputSchema, imageProfilesService } from '@/server/services/image-profiles';
export const dynamic = 'force-dynamic';

export const GET = route('viewer', async ({ req, session }) => {
  const project = await requestProject(req, session);
  return { project: { id: project.id, name: project.name }, profiles: await imageProfilesService(session).list(project),
    capabilities: { canApprove: session.role === 'admin' && session.authMethod !== 'token', canSeed: session.role === 'admin' && session.authMethod !== 'token' } };
});
export const POST = route('admin', async ({ req, session }) =>
  imageProfilesService(session).approve(await body(req, imageProfileInputSchema), await requestProject(req, session)),
{ audit: 'image-profile.approve' });
