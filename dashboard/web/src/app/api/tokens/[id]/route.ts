import { route } from '@/server/api';
import { requestProject } from '@/server/auth/projects';
import { assertBrowserManagementRequest, revokeApiToken } from '@/server/auth/api-tokens';
export const dynamic = 'force-dynamic';
export const DELETE = route<{ id: string }>('viewer', async ({ req, session, params }) => {
  assertBrowserManagementRequest(req);
  const project = await requestProject(req, session);
  await revokeApiToken(session, project, params.id);
  return { ok: true };
}, { audit: 'token.revoke' });
