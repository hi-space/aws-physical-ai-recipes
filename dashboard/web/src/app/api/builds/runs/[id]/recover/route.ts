import { z } from 'zod';
import { body, route } from '@/server/api';
import { requestProject } from '@/server/auth/projects';
import { sourceBuildService } from '@/server/services/source-builds';
export const dynamic = 'force-dynamic';
export const POST = route<{ id: string }>('researcher', async ({ req, session, params }) => {
  const input = await body(req, z.object({ buildId: z.string().min(1).max(160) }).strict());
  return sourceBuildService(session).recover(params.id, input.buildId,
    await requestProject(req, session, 'project-admin'), req.signal);
}, { audit: 'source-build.recover' });
