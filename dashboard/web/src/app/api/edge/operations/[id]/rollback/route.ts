import { body, route } from '@/server/api';
import { z } from 'zod';
import { requestProject } from '@/server/auth/projects';
import { devicesService } from '@/server/services/devices';
export const dynamic = 'force-dynamic';
export const POST = route<{ id: string }>('researcher', async ({ req, session, params }) => {
  const request = await body(req, z.object({ allowUnapprovedBenchmark: z.boolean().default(false) }).strict());
  return devicesService().rollback(session, (await requestProject(req, session, 'researcher')).id, params.id, request.allowUnapprovedBenchmark);
}, { audit: 'edge.rollback.prepare' });
