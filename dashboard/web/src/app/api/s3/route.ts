import { z } from 'zod';
import { body, q, route } from '@/server/api';
import * as s3 from '@/server/aws/s3';
export const dynamic = 'force-dynamic';
export const GET = route('viewer', async ({ url }) => {
  const bucket = q(url, 'bucket');
  if (!bucket) return { buckets: s3.allowedBuckets() };
  return s3.list(bucket, q(url, 'prefix') ?? '', q(url, 'token'));
});
export const DELETE = route('admin', async ({ req }) => {
  const b = await body(req, z.object({ bucket: z.string(), keys: z.array(z.string()).max(1000).optional(), prefix: z.string().min(1).optional() }));
  if (b.prefix) return { deleted: await s3.deletePrefix(b.bucket, b.prefix) };
  await s3.deleteKeys(b.bucket, b.keys ?? []);
  return { deleted: b.keys?.length ?? 0 };
}, { audit: 's3.delete' });
