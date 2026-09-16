import { body, route } from '@/server/api';
import { requestProject } from '@/server/auth/projects';
import { modelsService, registryApprovalSchema } from '@/server/services/models';
export const dynamic = 'force-dynamic';
export const POST = route<{ id: string }>('researcher', async ({ req, session, params }) => {
  const project = await requestProject(req, session, 'project-admin');
  return modelsService().propagateRegistry(session, project.id, params.id, await body(req, registryApprovalSchema));
}, { audit: 'model.sagemaker-approval-explicit' });
