import { z } from 'zod';
import { assertDatasetOwner } from '@/server/services/datasets';
import { body, q, route } from '@/server/api';
import { listFiles, refreshSize, setVersionTags } from '@/server/services/datasets';
export const dynamic = 'force-dynamic';
export const GET = route<{ name: string; v: string }>('viewer', async ({ params, url }) => listFiles(params.name, Number(params.v), q(url, 'prefix') ?? '', q(url, 'token')));
export const POST = route<{ name: string; v: string }>('researcher', async ({ params, req, session }) => {
  await assertDatasetOwner(session, params.name);
  const b = await body(req, z.object({ action: z.enum(['refresh-size', 'tags']), tags: z.array(z.string()).optional() }));
  if (b.action === 'tags') return setVersionTags(params.name, Number(params.v), b.tags ?? []);
  return refreshSize(params.name, Number(params.v));
}, { audit: 'dataset.version.update' });
