import { z } from 'zod';
import { body, route } from '@/server/api';
import { requestProject } from '@/server/auth/projects';
import { startProjectPipeline } from '@/server/services/pipelines';
import { NextResponse } from 'next/server';
export const dynamic = 'force-dynamic';
export const POST = route('researcher', async ({ req, session }) => {
  const b = await body(req, z.object({ parameters: z.record(z.string(), z.string()), displayName: z.string().optional() }));
  const project = await requestProject(req, session, 'researcher');
  return NextResponse.json(await startProjectPipeline(session, project, b, req.headers.get('idempotency-key') ?? undefined), { status: 202 });
}, { audit: 'pipeline.start' });
