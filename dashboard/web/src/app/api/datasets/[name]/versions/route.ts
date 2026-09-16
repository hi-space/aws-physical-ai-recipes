import { z } from 'zod';
import { body, route } from '@/server/api';
import { createVersion } from '@/server/services/datasets';
export const dynamic = 'force-dynamic';
export const POST = route<{ name: string }>('researcher', async ({ params, req, session }) => {
  const b = await body(req, z.object({ uri: z.string().startsWith('s3://').optional(), note: z.string().max(500).optional(), tags: z.array(z.string()).optional() }));
  return createVersion(params.name, b, session.user);
}, { audit: 'dataset.version.create' });
