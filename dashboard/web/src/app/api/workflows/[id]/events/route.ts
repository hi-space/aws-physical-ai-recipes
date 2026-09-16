import { route } from '@/server/api';
import { getRepo } from '@/server/store/repo';
import { listEvents } from '@/server/k8s/resources';
import { notFound } from '@/server/errors';
export const dynamic = 'force-dynamic';
export const GET = route<{ id: string }>('viewer', async ({ params }) => {
  const repo = getRepo();
  const wf = await repo.getWorkflow(params.id);
  if (!wf) throw notFound(`workflow ${params.id}`);
  const [controller, k8s] = await Promise.all([
    repo.listEvents(params.id),
    listEvents(wf.namespace).then((evs) => evs.filter((e) => e.involvedObject?.name?.startsWith(`wf-${params.id}-`)).slice(0, 100)).catch(() => []),
  ]);
  return { controller, kubernetes: k8s };
});
