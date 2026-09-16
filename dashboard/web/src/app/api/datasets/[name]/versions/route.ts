import { z } from 'zod';
import { assertDatasetOwner } from '@/server/services/datasets';
import { body, route } from '@/server/api';
import { createVersion } from '@/server/services/datasets';
import { assertStorageScope, requestProject } from '@/server/auth/projects';
import { parseS3Uri } from '@/server/aws/s3';
export const dynamic = 'force-dynamic';
export const POST = route<{ name: string }>('researcher', async ({ params, req, session }) => {
  await assertDatasetOwner(session, params.name);
  const b = await body(req, z.object({ uri: z.string().startsWith('s3://').optional(), note: z.string().max(500).optional(), tags: z.array(z.string()).optional(), include: z.array(z.string().max(1024)).max(128).optional(), exclude: z.array(z.string().max(1024)).max(128).optional() }));
  if (b.uri && session.role !== 'admin') assertStorageScope(session, await requestProject(req, session, 'researcher'), parseS3Uri(b.uri).key);
  return createVersion(params.name, b, session.user);
}, { audit: 'dataset.version.create' });
