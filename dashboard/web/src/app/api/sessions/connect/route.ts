import { z } from 'zod';
import { route } from '@/server/api';
import { requestProject } from '@/server/auth/projects';
import { badRequest } from '@/server/errors';
import { taskConnectionOptions } from '@/server/services/sessions';
export const dynamic = 'force-dynamic';
const input = z.object({ workflowId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/), taskName: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/) }).strict();
export const GET = route('researcher', async ({ req, session, url }) => {
  const parsed = input.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) throw badRequest('Select a workflow and task');
  const project = await requestProject(req, session, 'researcher');
  return taskConnectionOptions(parsed.data.workflowId, parsed.data.taskName, session, project);
});
