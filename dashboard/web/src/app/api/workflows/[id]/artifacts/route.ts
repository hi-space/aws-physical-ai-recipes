import { NextResponse } from 'next/server';
import { route } from '@/server/api';
import { getRepo } from '@/server/store/repo';
import { listWorkflowArtifacts } from '@/server/services/workflow-artifacts';
export const dynamic = 'force-dynamic';

/** Files a workflow published, per task and dataset version, resolved from the pinned manifests.
 * Workflow-level access is enforced by the route wrapper (authorizeApiResource). */
export const GET = route<{ id: string }>('viewer', async ({ params, req }) =>
  NextResponse.json(await listWorkflowArtifacts(getRepo(), params.id, req.signal), { headers: { 'cache-control': 'no-store' } }));
