import { route } from '@/server/api';
import { requestProject } from '@/server/auth/projects';
import { devicesService } from '@/server/services/devices';
export const dynamic = 'force-dynamic';
export const GET = route('viewer', async ({ req, session }) => devicesService().list(session, (await requestProject(req, session)).id));
