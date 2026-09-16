import { z } from 'zod';
import { body, q, route } from '@/server/api';
import * as s3 from '@/server/aws/s3';
import { assertStorageScope, requestProject } from '@/server/auth/projects';
export const dynamic = 'force-dynamic';
export const GET = route('viewer', async ({ url, req, session }) => {
  const bucket = q(url, 'bucket');
  if (!bucket) return { buckets: s3.allowedBuckets() };
  const project = session.role === 'admin' ? undefined : await requestProject(req, session);
  const rootPrefix = project ? (bucket === process.env.DASHBOARD_ARTIFACT_BUCKET ? `projects/${project.id}/` : `datasets/projects/${project.id}/`) : '';
  const prefix = q(url, 'prefix') || rootPrefix;
  if (project) assertStorageScope(session, project, prefix);
  return { ...await s3.list(bucket, prefix, q(url, 'token')), rootPrefix };
});
export const DELETE = route('admin', async ({ req }) => {
  const b = await body(req, z.object({ bucket: z.string(), keys: z.array(z.string()).max(1000).optional(), prefix: z.string().min(1).optional() }));
  if (b.prefix) return { deleted: await s3.deletePrefix(b.bucket, b.prefix) };
  await s3.deleteKeys(b.bucket, b.keys ?? []);
  return { deleted: b.keys?.length ?? 0 };
}, { audit: 's3.delete' });
