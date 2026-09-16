import { route } from '@/server/api';
import { getRepo } from '@/server/store/repo';
import { listEvents } from '@/server/k8s/resources';
import { notFound } from '@/server/errors';
import { jobSetNameFor } from '@/server/workflow/compile';
export const dynamic = 'force-dynamic';
export const GET = route<{ id: string }>('viewer', async ({ params }) => {
  const repo = getRepo();
  const wf = await repo.getWorkflow(params.id);
  if (!wf) throw notFound(`workflow ${params.id}`);
  const tasks = await repo.listTasks(wf.id);
  const prefixes = [`wf-${wf.id}-`];
  const roots = new Set<string>();
  for (const group of wf.spec.workflow.groups ?? []) {
    const attempts = Math.max(1, ...tasks.filter((task) => task.groupId === group.name).map((task) => task.attempts));
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const root = jobSetNameFor(wf.id, group.name, attempt);
      roots.add(root); prefixes.push(`${root}-`);
    }
  }
  let kubernetesError: string | undefined;
  const [controller, k8s] = await Promise.all([
    repo.listEvents(params.id),
    listEvents(wf.namespace).then((evs) => evs.filter((event) => {
      const name = event.involvedObject?.name ?? '';
      return roots.has(name) || prefixes.some((prefix) => name.startsWith(prefix));
    }).slice(0, 100)).catch(() => { kubernetesError = 'Kubernetes 이벤트를 조회하지 못했습니다.'; return []; }),
  ]);
  return { controller, kubernetes: k8s, kubernetesError };
});
