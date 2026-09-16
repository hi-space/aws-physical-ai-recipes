import { route } from '@/server/api';
import { requestProject } from '@/server/auth/projects';
import { modelsService } from '@/server/services/models';
export const dynamic = 'force-dynamic';

export const GET = route<{ id: string }>('viewer', async ({ req, session, params }) =>
  modelsService().get(session, (await requestProject(req, session)).id, params.id));
