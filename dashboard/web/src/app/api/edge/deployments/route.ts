import { body, route } from '@/server/api';
import { requestProject } from '@/server/auth/projects';
import { deploymentSchema, devicesService } from '@/server/services/devices';
export const dynamic = 'force-dynamic';
// Prepare is durable application metadata only. AWS mutation needs the separate submit action.
export const POST = route('researcher', async ({ req, session }) => devicesService().prepare(session, (await requestProject(req, session, 'researcher')).id, await body(req, deploymentSchema)), { audit: 'edge.prepare' });
