import { z } from 'zod';
import { body, route } from '@/server/api';
import { getRepo } from '@/server/store/repo';
import { createDataset } from '@/server/services/datasets';
export const dynamic = 'force-dynamic';
export const GET = route('viewer', async () => getRepo().listDatasets());
export const POST = route('researcher', async ({ req, session }) => {
  const b = await body(req, z.object({ name: z.string(), description: z.string().max(500).optional(), tags: z.array(z.string()).optional(), format: z.string().optional() }));
  return createDataset(b, session.user);
}, { audit: 'dataset.create' });
