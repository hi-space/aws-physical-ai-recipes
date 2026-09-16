import { z } from 'zod';
import { body, route } from '@/server/api';
import * as s3 from '@/server/aws/s3';
import { assertStorageScope, requestProject } from '@/server/auth/projects';
import { forbidden } from '@/server/errors';
export const dynamic = 'force-dynamic';
export const POST = route('viewer', async ({ req, session }) => {
  const b = await body(req, z.object({ bucket: z.string(), key: z.string().min(1), op: z.enum(['get', 'put']).default('get'), contentType: z.string().optional() }));
  if (b.op === 'put' && session.role === 'viewer') throw forbidden('viewers cannot upload');
  if (session.role !== 'admin') {
    const project = await requestProject(req, session, b.op === 'put' ? 'researcher' : 'viewer');
    assertStorageScope(session, project, b.key);
    if (b.op === 'put' && !b.key.startsWith(`projects/${project.id}/scratch/`)) throw forbidden('Use the dataset upload flow for versioned data');
  }
  return { url: b.op === 'get' ? await s3.presignGet(b.bucket, b.key) : await s3.presignPut(b.bucket, b.key, b.contentType) };
});
