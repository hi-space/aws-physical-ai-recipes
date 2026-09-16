import { z } from 'zod';
import { body, route } from '@/server/api';
import { requestProject } from '@/server/auth/projects';
import { badRequest } from '@/server/errors';
import { parseWorkflowYaml } from '@/server/workflow/template';
import { imageProfilesService } from '@/server/services/image-profiles';
export const dynamic = 'force-dynamic';

export const POST = route('viewer', async ({ req, session }) => {
  const project = await requestProject(req, session);
  const input = await body(req, z.object({ yaml: z.string().min(1).max(256 * 1024) }).strict());
  let spec;
  try { spec = parseWorkflowYaml(input.yaml).spec; }
  catch { throw badRequest('워크플로우 YAML/JSON 형식과 작업 자원을 확인하세요.'); }
  return imageProfilesService(session).preflight(spec, project);
});
