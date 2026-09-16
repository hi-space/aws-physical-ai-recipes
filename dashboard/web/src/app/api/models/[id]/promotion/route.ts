import { body, route } from '@/server/api';
import { requestProject } from '@/server/auth/projects';
import { modelsService, promotionSchema } from '@/server/services/models';
export const dynamic = 'force-dynamic';

export const POST = route<{ id: string }>('researcher', async ({ req, session, params }) =>
  modelsService().promote(session, (await requestProject(req, session, 'researcher')).id, params.id, await body(req, promotionSchema)),
{ audit: 'model.application-quality-gate' });
