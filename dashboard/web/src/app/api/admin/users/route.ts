import { z } from 'zod';
import { body, route } from '@/server/api';
import * as cog from '@/server/aws/cognito';
export const dynamic = 'force-dynamic';
export const GET = route('admin', async () => {
  const [users, groups] = await Promise.all([cog.listUsers(), cog.listGroups()]);
  return { users, groups };
});
export const POST = route('admin', async ({ req }) => {
  const b = await body(req, z.object({ username: z.string().min(1).max(64), email: z.string().email(), password: z.string().min(12), group: z.enum(['admins', 'researchers', 'viewers']) }));
  await cog.createUser(b.username, b.email, b.password, b.group);
  return { ok: true };
}, { audit: 'user.create' });
