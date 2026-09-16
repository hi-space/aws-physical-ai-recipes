import { route } from '@/server/api';
import { requestProject } from '@/server/auth/projects';
import { devicesService } from '@/server/services/devices';
export const dynamic = 'force-dynamic';
export const GET = route<{ id: string }>('viewer', async ({ req, session, params, url }) => devicesService().operation(session, (await requestProject(req, session)).id, params.id, url.searchParams.get('refresh') === '1'));
