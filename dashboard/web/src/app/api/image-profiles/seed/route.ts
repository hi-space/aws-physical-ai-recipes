import { z } from 'zod';
import { body, route } from '@/server/api';
import { requestProject } from '@/server/auth/projects';
import { imageProfilesService } from '@/server/services/image-profiles';
export const dynamic = 'force-dynamic';

export const POST = route('admin', async ({ req, session }) => {
  await body(req, z.object({}).strict());
  return imageProfilesService(session).seed(await requestProject(req, session));
}, { audit: 'image-profile.seed-candidates' });
