import { route } from '@/server/api';
import { requestProject } from '@/server/auth/projects';
import { badRequest } from '@/server/errors';
import { modelsService } from '@/server/services/models';
export const dynamic = 'force-dynamic';

export const GET = route<{ id: string }>('viewer', async ({ req, session, params, url }) => {
  const kind = url.searchParams.get('kind');
  if (kind !== 'report' && kind !== 'video') throw badRequest('Select a pinned report or video');
  const location = await modelsService().artifact(session, (await requestProject(req, session)).id, params.id, kind);
  return new Response(null, { status: 302, headers: { location, 'cache-control': 'private, no-store' } });
});
