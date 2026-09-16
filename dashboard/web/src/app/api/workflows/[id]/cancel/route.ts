import { route } from '@/server/api';
import { assertOwner } from '@/server/auth/session';
import { notFound } from '@/server/errors';
import { getRepo } from '@/server/store/repo';
import { TERMINAL_WF } from '@/server/store/types';
import { NextResponse } from 'next/server';
export const dynamic = 'force-dynamic';
export const POST = route<{ id: string }>('researcher', async ({ params, session }) => {
  const wf = await getRepo().getWorkflow(params.id);
  if (!wf) throw notFound(`workflow ${params.id}`);
  assertOwner(session, wf.owner, 'workflow');
  if (!TERMINAL_WF.has(wf.status)) await getRepo().requestCancellation(wf.id, session.user, new Date().toISOString());
  return NextResponse.json({ id: wf.id, operationId: wf.id, status: TERMINAL_WF.has(wf.status) ? wf.status : 'CANCELLING' }, { status: 202 });
}, { audit: 'workflow.cancel' });
