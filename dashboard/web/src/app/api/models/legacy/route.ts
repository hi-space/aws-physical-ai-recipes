import { route } from '@/server/api';
import { requestProject } from '@/server/auth/projects';
import { modelsService } from '@/server/services/models';
export const dynamic = 'force-dynamic';

export const GET = route('admin', async ({ req, session }) =>
  modelsService().legacy(session, (await requestProject(req, session)).id));
