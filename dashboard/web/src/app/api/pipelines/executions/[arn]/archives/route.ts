import { body, route } from '@/server/api';
import { requestProject } from '@/server/auth/projects';
import { archiveRequestSchema, pipelineArchives } from '@/server/services/pipeline-archives';
import { NextResponse } from 'next/server';
export const dynamic = 'force-dynamic';
export const GET = route<{ arn: string }>('viewer', async ({ req, session, params }) =>
  pipelineArchives().list(session, (await requestProject(req, session)).id, decodeURIComponent(params.arn)));
export const POST = route<{ arn: string }>('researcher', async ({ req, session, params }) => {
  const project = await requestProject(req, session, 'researcher');
  const result = await pipelineArchives().request(session, project.id, decodeURIComponent(params.arn), await body(req, archiveRequestSchema));
  return NextResponse.json(result, { status: result.status === 'READY' ? 200 : 202 });
}, { audit: 'pipeline.archive-request' });
