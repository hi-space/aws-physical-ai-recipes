import { NextResponse } from 'next/server';
import { z } from 'zod';
import { body, route } from '@/server/api';
import { requestProject } from '@/server/auth/projects';
import { sourceBuildService } from '@/server/services/source-builds';
export const dynamic = 'force-dynamic';
export const GET = route<{ id: string }>('viewer', async ({ req, session, params }) =>
  sourceBuildService(session).get(params.id, await requestProject(req, session)));
export const POST = route<{ id: string }>('researcher', async ({ req, session, params }) => {
  await body(req, z.object({ action: z.literal('cancel') }).strict());
  return NextResponse.json(await sourceBuildService(session).cancel(params.id,
    await requestProject(req, session, 'researcher')), { status: 202 });
}, { audit: 'source-build.cancel' });
