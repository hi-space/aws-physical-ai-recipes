import { route, body } from '@/server/api';
import { createProject, ensureDefaultProject, listProjects, projectInputSchema } from '@/server/auth/projects';
import { listLocalQueues } from '@/server/k8s/kueue';
import { badRequest } from '@/server/errors';
import { runOnBackend } from '@/server/backends/context';
export const dynamic = 'force-dynamic';
export const GET = route('viewer', async ({ session }) => {
  await ensureDefaultProject(session);
  return listProjects(session);
});
export const POST = route('admin', async ({ req, session }) => {
  const input = await body(req, projectInputSchema);
  return runOnBackend(input, async () => {
  const queue = (await listLocalQueues()).find((queue) => queue.metadata.namespace === input.namespace && queue.metadata.name === `${input.namespace}-localqueue`);
  if (!queue) throw badRequest('실행 가능한 큐가 준비된 연구 자원 풀을 선택하세요.');
  return createProject(session, input);
  });
}, { audit: 'project.create' });
