import { z } from 'zod';
import { body, route } from '@/server/api';
import { config, ENV_KEYS } from '@/server/config';
import { getRepo } from '@/server/store/repo';
import { controllerHealth } from '@/server/services/overview';
export const dynamic = 'force-dynamic';
export const GET = route('admin', async () => {
  const env: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) env[k] = k.includes('SECRET') ? (process.env[k] ? '<set>' : undefined) : process.env[k];
  return { config: config(), env, settings: await getRepo().getSettings(), controller: await controllerHealth(), lease: await getRepo().getLease('CONTROLLER') };
});
export const PUT = route('admin', async ({ req }) => {
  const b = await body(req, z.object({ notifyOn: z.array(z.enum(['SUCCEEDED', 'FAILED', 'CANCELLED'])), defaultNamespace: z.string().min(1), defaultPriority: z.string().optional() }));
  await getRepo().putSettings(b);
  return b;
}, { audit: 'settings.update' });
