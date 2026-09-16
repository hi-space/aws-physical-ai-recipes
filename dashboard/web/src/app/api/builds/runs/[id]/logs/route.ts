import { q, route } from '@/server/api';
import { requestProject } from '@/server/auth/projects';
import { sourceBuildService } from '@/server/services/source-builds';
export const dynamic = 'force-dynamic';
export const GET = route<{ id: string }>('viewer', async ({ req, session, params, url }) =>
  sourceBuildService(session).logs(params.id, await requestProject(req, session), q(url, 'cursor'), req.signal));
