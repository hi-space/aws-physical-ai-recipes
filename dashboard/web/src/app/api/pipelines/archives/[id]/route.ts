import { route } from '@/server/api';
import { requestProject } from '@/server/auth/projects';
import { pipelineArchives } from '@/server/services/pipeline-archives';
export const dynamic = 'force-dynamic';
export const GET = route<{ id: string }>('viewer', async ({ req, session, params }) =>
  pipelineArchives().get(session, (await requestProject(req, session)).id, params.id));
export const POST = route<{ id: string }>('researcher', async ({ req, session, params }) =>
  pipelineArchives().retry(session, (await requestProject(req, session, 'researcher')).id, params.id),
{ audit: 'pipeline.archive-retry' });
export const DELETE = route<{ id: string }>('researcher', async ({ req, session, params }) =>
  pipelineArchives().cancel(session, (await requestProject(req, session, 'researcher')).id, params.id),
{ audit: 'pipeline.archive-cancel' });
