import { z } from 'zod';
import { body, route } from '@/server/api';
import * as gg from '@/server/aws/greengrass';
export const dynamic = 'force-dynamic';
export const POST = route('admin', async ({ req }) => {
  const b = await body(req, z.object({ name: z.string().min(1).max(60), modelPath: z.string().min(1), embodimentTag: z.string().default('NEW_EMBODIMENT'), ecrImage: z.string().min(1), policyPort: z.number().int().optional() }));
  return { deploymentId: await gg.createInferenceDeployment(b) };
}, { audit: 'edge.deploy' });
