import { body, route } from '@/server/api';
import { requestProject } from '@/server/auth/projects';
import { executionProfileInputSchema, executionProfilesService } from '@/server/services/execution-profiles';
import { executionNodeBinding, TRUSTED_NODE_LABEL, TRUSTED_NODE_TAINT } from '@/server/workflow/execution-profile-policy';
export const dynamic = 'force-dynamic';
export const GET = route('viewer', async ({ req, session, url }) => {
  const project = await requestProject(req, session);
  const id = url.searchParams.get('id');
  return {
    profiles: await executionProfilesService(session).list(project),
    canApprove: session.role === 'admin' && session.authMethod !== 'token',
    project: { id: project.id, name: project.name },
    ...(id && /^[a-z][a-z0-9-]{0,39}$/.test(id) ? { requiredNodeConfiguration: {
      label: `${TRUSTED_NODE_LABEL}=${executionNodeBinding(project.id, id)}`,
      taint: `${TRUSTED_NODE_TAINT}=${executionNodeBinding(project.id, id)}:NoSchedule`,
    } } : {}),
  };
});
export const POST = route('admin', async ({ req, session }) =>
  executionProfilesService(session).approve(await body(req, executionProfileInputSchema), await requestProject(req, session)),
{ audit: 'execution-profile.approve' });
