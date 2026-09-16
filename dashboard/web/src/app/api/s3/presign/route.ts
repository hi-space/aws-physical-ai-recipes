import { z } from 'zod';
import { body, route } from '@/server/api';
import * as s3 from '@/server/aws/s3';
export const dynamic = 'force-dynamic';
export const POST = route('viewer', async ({ req, session }) => {
  const b = await body(req, z.object({ bucket: z.string(), key: z.string().min(1), op: z.enum(['get', 'put']).default('get'), contentType: z.string().optional() }));
  if (b.op === 'put' && session.role === 'viewer') throw new Error('viewers cannot upload');
  return { url: b.op === 'get' ? await s3.presignGet(b.bucket, b.key) : await s3.presignPut(b.bucket, b.key, b.contentType) };
});
