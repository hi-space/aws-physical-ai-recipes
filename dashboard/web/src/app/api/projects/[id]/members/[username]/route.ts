import { z } from 'zod';
import { body, route } from '@/server/api';
import { setProjectMembership } from '@/server/auth/project-members';
export const dynamic = 'force-dynamic';
const schema = z.object({ role: z.enum(['member', 'project-admin']).nullable() }).strict();
export const PUT = route<{ id: string; username: string }>('viewer', async ({ session, params, req }) => {
  const { role } = await body(req, schema);
  await setProjectMembership(session, params.id, params.username, role);
  return { ok: true };
}, { audit: 'project.members' });
