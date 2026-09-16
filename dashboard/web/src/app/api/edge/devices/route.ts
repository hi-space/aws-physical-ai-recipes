import { body, route } from '@/server/api';
import { requestProject } from '@/server/auth/projects';
import { deviceRegistrationSchema, devicesService } from '@/server/services/devices';
export const dynamic = 'force-dynamic';
export const POST = route('researcher', async ({ req, session }) => devicesService().register(session, (await requestProject(req, session, 'project-admin')).id, await body(req, deviceRegistrationSchema)), { audit: 'edge.register' });
