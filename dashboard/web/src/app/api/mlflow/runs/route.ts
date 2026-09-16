import { q, route } from '@/server/api';
import { requestProject } from '@/server/auth/projects';
import { badRequest } from '@/server/errors';
import { trackingAccess } from '@/server/services/tracking-access';
export const dynamic = 'force-dynamic';
export const GET = route('viewer', async ({ req, session, url }) => {
  const project = await requestProject(req, session);
  const exp = q(url, 'experiment');
  if (!exp) throw badRequest('experiment required');
  return trackingAccess().runs(session, project.id, exp.split(','), q(url, 'filter') ?? '', Number(q(url, 'max') ?? 100));
});
