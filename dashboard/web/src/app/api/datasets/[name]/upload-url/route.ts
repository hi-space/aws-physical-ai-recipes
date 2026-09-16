import { z } from 'zod';
import { body, route } from '@/server/api';
import { uploadUrl } from '@/server/services/datasets';
export const dynamic = 'force-dynamic';
export const POST = route<{ name: string }>('researcher', async ({ params, req }) => {
  const b = await body(req, z.object({ version: z.number().int().positive(), filename: z.string().min(1), contentType: z.string().optional() }));
  return uploadUrl(params.name, b.version, b.filename, b.contentType);
}, { audit: 'dataset.upload-url' });
