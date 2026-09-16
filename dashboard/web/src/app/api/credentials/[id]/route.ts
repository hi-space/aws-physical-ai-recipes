import { route } from '@/server/api';
import { requestProject } from '@/server/auth/projects';
import { assertBrowserManagementRequest } from '@/server/auth/api-tokens';
import { deleteCredential } from '@/server/services/credentials';
export const dynamic = 'force-dynamic';
export const DELETE = route<{ id: string }>('researcher', async ({ req, session, params }) => {
  assertBrowserManagementRequest(req);
  const project = await requestProject(req, session, 'researcher');
  await deleteCredential(session, project, params.id);
  return { ok: true };
}, { audit: 'credential.delete' });
