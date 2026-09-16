import { NextResponse } from 'next/server';
import { body, route } from '@/server/api';
import { requestProject } from '@/server/auth/projects';
import { API_SCOPES, apiTokenInputSchema, assertBrowserManagementRequest, createApiToken, listApiTokens } from '@/server/auth/api-tokens';
export const dynamic = 'force-dynamic';
export const GET = route('viewer', async ({ req, session }) => {
  assertBrowserManagementRequest(req);
  const project = await requestProject(req, session);
  const canWrite = session.role !== 'viewer' && ['researcher', 'project-admin'].includes(project.members[session.subject ?? '']);
  return NextResponse.json({ projectId: project.id, tokens: await listApiTokens(session, project), availableScopes: API_SCOPES.filter((scope) => canWrite || !scope.endsWith(':write')) }, { headers: { 'Cache-Control': 'no-store' } });
});
export const POST = route('viewer', async ({ req, session }) => {
  assertBrowserManagementRequest(req);
  const project = await requestProject(req, session);
  const result = await createApiToken(session, project, await body(req, apiTokenInputSchema));
  return NextResponse.json(result, { status: 201, headers: { 'Cache-Control': 'no-store', 'Pragma': 'no-cache', 'Referrer-Policy': 'no-referrer' } });
}, { audit: 'token.create' });
