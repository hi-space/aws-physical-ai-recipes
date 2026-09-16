import { z } from 'zod';
import { body, route } from '@/server/api';
import { requestProject } from '@/server/auth/projects';
import { executionProfilesService } from '@/server/services/execution-profiles';
export const dynamic = 'force-dynamic';
export const GET = route<{ id: string }>('viewer', async ({ req, session, params, url }) => {
  const version = url.searchParams.get('version');
  return executionProfilesService(session).get(params.id, await requestProject(req, session), version === null ? undefined : Number(version));
});
export const DELETE = route<{ id: string }>('admin', async ({ req, session, params }) => {
  const input = await body(req, z.object({ expectedVersion: z.number().int().positive() }).strict());
  await executionProfilesService(session).disable(params.id, await requestProject(req, session), input.expectedVersion);
  return { disabled: true };
}, { audit: 'execution-profile.disable' });
