import { z } from 'zod';
import { body, route } from '@/server/api';
import * as sm from '@/server/aws/sagemaker';
export const dynamic = 'force-dynamic';
export const POST = route('researcher', async ({ req, session }) => {
  const b = await body(req, z.object({ parameters: z.record(z.string(), z.string()), displayName: z.string().optional() }));
  const arn = await sm.startExecution(b.parameters, b.displayName ?? `dash-${session.user}-${Date.now()}`);
  return { arn };
}, { audit: 'pipeline.start' });
