import { z } from 'zod';
import { body, route } from '@/server/api';
import { createTensorBoard, listSessionsWithStatus } from '@/server/services/sessions';
export const dynamic = 'force-dynamic';
export const GET = route('viewer', async () => listSessionsWithStatus());
export const POST = route('researcher', async ({ req, session }) => {
  const b = await body(req, z.object({ kind: z.literal('tensorboard'), logDir: z.string().min(1), namespace: z.string().optional() }));
  return createTensorBoard(b, session.user);
}, { audit: 'session.create' });
