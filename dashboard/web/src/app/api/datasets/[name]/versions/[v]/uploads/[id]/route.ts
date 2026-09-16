import { z } from 'zod';
import { body, route } from '@/server/api';
import { MultipartUploads } from '@/server/services/multipart-uploads';
export const dynamic = 'force-dynamic';
const input = z.discriminatedUnion('action', [z.object({ action: z.literal('part'), partNumber: z.number().int().positive(), checksumSHA256: z.string().max(44) }).strict(), z.object({ action: z.literal('complete'), checksums: z.array(z.string().max(44)).min(1).max(10000) }).strict()]);
type Params = {
  name: string;
  v: string;
  id: string;
};
export const GET = route<Params>('researcher', async ({
  session,
  params
}) => new MultipartUploads().status(session, params.name, Number(params.v), params.id));
export const POST = route<Params>('researcher', async ({
  session,
  params,
  req
}) => {
  const value = await body(req, input),
    service = new MultipartUploads();
  return value.action === 'part' ? service.part(session, params.name, Number(params.v), params.id, value.partNumber, value.checksumSHA256) : service.complete(session, params.name, Number(params.v), params.id, value.checksums);
}, { audit: 'dataset.multipart.update' });
export const DELETE = route<Params>('researcher', async ({
  session,
  params
}) => new MultipartUploads().abort(session, params.name, Number(params.v), params.id), { audit: 'dataset.multipart.abort' });
