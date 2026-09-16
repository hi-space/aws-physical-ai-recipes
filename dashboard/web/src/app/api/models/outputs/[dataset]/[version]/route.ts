import { route } from '@/server/api';
import { requestProject } from '@/server/auth/projects';
import { badRequest } from '@/server/errors';
import { modelsService } from '@/server/services/models';
export const dynamic = 'force-dynamic';

export const GET = route<{ dataset: string; version: string }>('viewer', async ({ req, session, params }) => {
  if (!/^[1-9]\d*$/.test(params.version)) throw badRequest('An explicit dataset version is required');
  return modelsService().output(session, (await requestProject(req, session)).id, params.dataset, Number(params.version));
});
