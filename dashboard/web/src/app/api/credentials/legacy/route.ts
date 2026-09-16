import { NextResponse } from 'next/server';
import { body, route } from '@/server/api';
import { requestProject } from '@/server/auth/projects';
import { assertBrowserManagementRequest } from '@/server/auth/api-tokens';
import { legacyCredentialSchema, registerLegacyCredential } from '@/server/services/credentials';
export const dynamic = 'force-dynamic';
export const POST = route('admin', async ({ req, session }) => {
  assertBrowserManagementRequest(req);
  const project = await requestProject(req, session);
  return NextResponse.json(await registerLegacyCredential(session, project, await body(req, legacyCredentialSchema)), { status: 201, headers: { 'Cache-Control': 'no-store' } });
}, { audit: 'credential.register-legacy' });
