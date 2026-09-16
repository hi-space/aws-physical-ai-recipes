import { z } from 'zod';
import { body, route } from '@/server/api';
import { MultipartUploads } from '@/server/services/multipart-uploads';
export const dynamic = 'force-dynamic';
const input = z.object({ filename: z.string().max(512), size: z.number().int().positive(), lastModified: z.number().int().nonnegative(), contentType: z.string().max(200).optional() }).strict();
export const GET = route<{
  name: string;
  v: string;
}>('researcher', async ({
  session,
  params
}) => new MultipartUploads().list(session, params.name, Number(params.v)));
export const POST = route<{
  name: string;
  v: string;
}>('researcher', async ({
  session,
  params,
  req
}) => new MultipartUploads().start(session, params.name, Number(params.v), await body(req, input)), { audit: 'dataset.multipart.start' });
