import { body, route } from '@/server/api';
import { z } from 'zod';
import { requestProject } from '@/server/auth/projects';
import { devicesService } from '@/server/services/devices';
export const dynamic = 'force-dynamic';
export const POST = route<{ id: string }>('researcher', async ({ req, session, params }) => {
  await body(req, z.object({}).strict());
  return devicesService().submit(session, (await requestProject(req, session, 'researcher')).id, params.id);
}, { audit: 'edge.submit' });
