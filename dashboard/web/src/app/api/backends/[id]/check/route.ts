import { z } from 'zod';
import { body, route } from '@/server/api';
import { inspectBackend } from '@/server/backends/registry';
export const dynamic = 'force-dynamic';
export const POST = route<{ id: string }>('admin', async ({ req, params, session }) => {
  const input = await body(req, z.object({ version: z.number().int().positive() }).strict());
  return inspectBackend(session, params.id, input.version);
}, { audit: 'backend.inspect' });
