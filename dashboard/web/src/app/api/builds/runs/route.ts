import { NextResponse } from 'next/server';
import { body, q, route } from '@/server/api';
import { requestProject } from '@/server/auth/projects';
import { sourceBuildService, sourceBuildInput } from '@/server/services/source-builds';
export const dynamic = 'force-dynamic';
export const GET = route('viewer', async ({ req, session, url }) =>
  sourceBuildService(session).list(await requestProject(req, session), q(url, 'cursor')));
export const POST = route('researcher', async ({ req, session }) => NextResponse.json(
  await sourceBuildService(session).start(await body(req, sourceBuildInput),
    await requestProject(req, session, 'researcher'), req.headers.get('idempotency-key') ?? '', req.signal),
  { status: 202 }), { audit: 'source-build.start' });
