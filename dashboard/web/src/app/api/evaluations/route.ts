import { body, route } from '@/server/api';
import { requestProject } from '@/server/auth/projects';
import { badRequest } from '@/server/errors';
import { ingestionSchema, modelsService } from '@/server/services/models';
export const dynamic = 'force-dynamic';

export const GET = route('viewer', async ({ req, session, url }) => {
  const modelId = url.searchParams.get('modelId');
  if (!modelId) throw badRequest('modelId is required');
  return (await modelsService().get(session, (await requestProject(req, session)).id, modelId)).evaluations;
});
export const POST = route('researcher', async ({ req, session }) =>
  modelsService().ingest(session, (await requestProject(req, session, 'researcher')).id, await body(req, ingestionSchema)),
{ audit: 'evaluation.ingest-published-report' });
