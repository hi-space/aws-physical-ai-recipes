import { NextResponse } from 'next/server';
import { body, route } from '@/server/api';
import { requestProject } from '@/server/auth/projects';
import { createManagedSession, createSessionSchema, listSessionsWithStatus, publicSession } from '@/server/services/sessions';
export const dynamic = 'force-dynamic';
export const GET = route('viewer', async ({ session }) => listSessionsWithStatus(session));
export const POST = route('researcher', async ({ req, session }) => {
  const input = await body(req, createSessionSchema);
  const project = await requestProject(req, session, 'researcher');
  const created = await createManagedSession(input, session, project);
  return NextResponse.json(publicSession(created, session), { status: 202 });
}, { audit: 'session.create' });
