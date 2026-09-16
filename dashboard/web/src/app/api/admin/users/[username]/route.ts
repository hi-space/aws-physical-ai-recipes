import { z } from 'zod';
import { body, route } from '@/server/api';
import * as cog from '@/server/aws/cognito';
export const dynamic = 'force-dynamic';
export const POST = route<{ username: string }>('admin', async ({ params, req }) => {
  const b = await body(req, z.object({ action: z.enum(['groups', 'reset']), groups: z.array(z.string()).optional(), password: z.string().min(12).optional() }));
  if (b.action === 'groups') await cog.setGroups(params.username, b.groups ?? []);
  else await cog.setPassword(params.username, b.password!);
  return { ok: true };
}, { audit: 'user.update' });
