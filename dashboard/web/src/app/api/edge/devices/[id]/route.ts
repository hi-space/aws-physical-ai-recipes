import { body, route } from '@/server/api';
import { requestProject } from '@/server/auth/projects';
import { deviceUpdateSchema, devicesService } from '@/server/services/devices';
export const dynamic = 'force-dynamic';
export const GET = route<{ id: string }>('viewer', async ({ req, session, params }) => devicesService().get(session, (await requestProject(req, session)).id, params.id));
export const PATCH = route<{ id: string }>('researcher', async ({ req, session, params }) => devicesService().update(session, (await requestProject(req, session, 'project-admin')).id, params.id, await body(req, deviceUpdateSchema)), { audit: 'edge.profiles.update' });
