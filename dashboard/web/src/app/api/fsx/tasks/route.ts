import { z } from 'zod';
import { body, q, route } from '@/server/api';
import * as fsx from '@/server/aws/fsx';
export const dynamic = 'force-dynamic';
export const GET = route('viewer', async ({ url }) => {
  const id = q(url, 'fileSystemId');
  if (!id) throw new Error('fileSystemId required');
  return fsx.listTasks(id);
});
export const POST = route('researcher', async ({ req }) => {
  const b = await body(req, z.object({ fileSystemId: z.string(), type: z.enum(['EXPORT_TO_REPOSITORY', 'IMPORT_METADATA_FROM_REPOSITORY']), paths: z.array(z.string()).min(1).max(32) }));
  return fsx.createTask(b.fileSystemId, b.type, b.paths);
}, { audit: 'fsx.task.create' });
