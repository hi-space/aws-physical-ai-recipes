import { body, route } from '@/server/api';
import { requestProject } from '@/server/auth/projects';
import { assertBrowserManagementRequest } from '@/server/auth/api-tokens';
import { rotateCredential, rotateCredentialSchema } from '@/server/services/credentials';
export const dynamic = 'force-dynamic';
export const POST = route<{ id: string }>('researcher', async ({ req, session, params }) => {
  assertBrowserManagementRequest(req);
  const project = await requestProject(req, session, 'researcher');
  const input = await body(req, rotateCredentialSchema);
  return rotateCredential(session, project, params.id, input.value);
}, { audit: 'credential.rotate' });
