import { body, q, route } from '@/server/api';
import { requestProject } from '@/server/auth/projects';
import { sourceBuildService, sourceRegistrationInput } from '@/server/services/source-builds';
export const dynamic = 'force-dynamic';
export const GET = route('viewer', async ({ req, session, url }) =>
  sourceBuildService(session).catalog(await requestProject(req, session), q(url, 'cursor')));
export const POST = route('researcher', async ({ req, session }) =>
  sourceBuildService(session).register(await body(req, sourceRegistrationInput),
    await requestProject(req, session, 'project-admin'), req.signal), { audit: 'source-build.register' });
