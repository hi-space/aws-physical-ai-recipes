import { NextResponse } from 'next/server';
import { body, route } from '@/server/api';
import { canWriteIn, isProjectAdmin, requestProject } from '@/server/auth/projects';
import { assertBrowserManagementRequest } from '@/server/auth/api-tokens';
import { createCredential, credentialInputSchema, listCredentials } from '@/server/services/credentials';
export const dynamic = 'force-dynamic';
export const GET = route('viewer', async ({ req, session }) => {
  assertBrowserManagementRequest(req);
  const project = await requestProject(req, session);
  return NextResponse.json({ projectId: project.id, credentials: await listCredentials(session, project), capabilities: {
    canWrite: session.role !== 'viewer' && canWriteIn(session, project),
    canShare: session.role !== 'viewer' && isProjectAdmin(session, project),
    canRegisterLegacy: session.role === 'admin',
  } }, { headers: { 'Cache-Control': 'no-store' } });
});
export const POST = route('researcher', async ({ req, session }) => {
  assertBrowserManagementRequest(req);
  const project = await requestProject(req, session, 'researcher');
  return NextResponse.json(await createCredential(session, project, await body(req, credentialInputSchema)), { status: 201, headers: { 'Cache-Control': 'no-store' } });
}, { audit: 'credential.create' });
