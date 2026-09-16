import { route } from '@/server/api';
import { requestProject } from '@/server/auth/projects';
import { imageProfilesService } from '@/server/services/image-profiles';
export const dynamic = 'force-dynamic';

export const GET = route<{ id: string }>('viewer', async ({ req, session, params, url }) => {
  const version = url.searchParams.get('version');
  return imageProfilesService(session).get(params.id, await requestProject(req, session), version === null ? undefined : Number(version));
});
export const DELETE = route<{ id: string }>('admin', async ({ req, session, params }) => {
  await imageProfilesService(session).disable(params.id, await requestProject(req, session));
  return { disabled: true };
}, { audit: 'image-profile.disable' });
