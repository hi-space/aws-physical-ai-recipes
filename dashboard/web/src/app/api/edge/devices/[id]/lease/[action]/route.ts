import { body, route } from '@/server/api';
import { requestProject } from '@/server/auth/projects';
import { badRequest } from '@/server/errors';
import { leaseProofSchema, devicesService } from '@/server/services/devices';
export const dynamic = 'force-dynamic';
export const POST = route<{ id: string; action: string }>('researcher', async ({ req, session, params }) => {
  if (!['validate', 'renew', 'release'].includes(params.action)) throw badRequest('Unknown lease action');
  return devicesService().lease(session, (await requestProject(req, session, 'researcher')).id, params.id, params.action as 'validate' | 'renew' | 'release', await body(req, leaseProofSchema));
}, { audit: 'edge.lease.proof' });
