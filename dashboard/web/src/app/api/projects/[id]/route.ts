import { z } from 'zod';
import { body, route } from '@/server/api';
import { resolveProject, updateProjectMembers } from '@/server/auth/projects';
export const dynamic = 'force-dynamic';
export const GET = route<{ id: string }>('viewer', async ({ session, params }) => resolveProject(session, params.id));
export const PATCH = route<{ id: string }>('researcher', async ({ session, params, req }) => {
  const input = await body(req, z.object({ members: z.record(z.string(), z.enum(['viewer', 'researcher', 'project-admin'])) }).strict());
  return updateProjectMembers(session, params.id, input.members);
}, { audit: 'project.members' });
