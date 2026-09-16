import { route } from '@/server/api';
import { requestProject } from '@/server/auth/projects';
import { projectExecution, stopProjectPipeline } from '@/server/services/pipelines';
import { NextResponse } from 'next/server';
export const dynamic = 'force-dynamic';
export const GET = route<{ arn: string }>('viewer', async ({ req, session, params }) => {
  const arn = decodeURIComponent(params.arn);
  return projectExecution(session, await requestProject(req, session), arn);
});
export const DELETE = route<{ arn: string }>('researcher', async ({ req, session, params }) => {
  return NextResponse.json(await stopProjectPipeline(session, await requestProject(req, session, 'researcher'), decodeURIComponent(params.arn)), { status: 202 });
}, { audit: 'pipeline.stop' });
