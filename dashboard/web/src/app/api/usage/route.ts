import { route } from '@/server/api';
import { requestProject, resolveProject } from '@/server/auth/projects';
import { projectUsage } from '@/server/services/usage';
export const dynamic = 'force-dynamic';
export const GET = route('viewer', async ({ req, session, url }) => {
  const requested = url.searchParams.get('projectId');
  const project = requested ? await resolveProject(session, requested) : await requestProject(req, session);
  return projectUsage(project.id, session);
});
