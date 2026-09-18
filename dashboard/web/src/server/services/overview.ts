import { backendConfig as config } from '../backends/context';
import { last30DaysByService } from '../aws/cost';
import { queryInstant } from '../aws/amp';
import { listClusterQueues, listWorkloads } from '../k8s/kueue';
import { controllerStatus } from '../workflow/controller';
import { getRepo } from '../store/repo';
import { allClusters, k8sNodes } from './compute';
import type { Session } from '../auth/session';
import { filterAccessible } from '../auth/projects';

let costCache: { at: number; value: Awaited<ReturnType<typeof last30DaysByService>> } | undefined;

async function safe<T>(p: Promise<T>, fallback: T): Promise<{ value: T; error?: string }> {
  try {
    return { value: await p };
  } catch (e) {
    return { value: fallback, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function overview(session?: Session) {
  const c = config();
  const repo = getRepo();
  const [clusters, nodes, workflows, cqs, workloads, gpuUtil] = await Promise.all([
    safe(allClusters(), []),
    safe(k8sNodes(), []),
    safe(repo.listWorkflows({ limit: 200 }), []),
    safe(c.eks ? listClusterQueues() : Promise.resolve([]), []),
    safe(c.eks ? listWorkloads() : Promise.resolve([]), []),
    safe(c.eks?.ampWorkspaceId ? queryInstant('avg(DCGM_FI_DEV_GPU_UTIL)') : Promise.resolve([]), []),
  ]);
  if (session?.role === 'admin' && (!costCache || Date.now() - costCache.at > 3600_000)) {
    const r = await safe(last30DaysByService(), { total: 0, byService: [], daily: [], fetchedAt: new Date().toISOString() });
    if (!r.error) costCache = { at: Date.now(), value: r.value };
  }
  const wfs = session ? await filterAccessible(session, workflows.value) : [];
  const byStatus: Record<string, number> = {};
  for (const w of wfs) byStatus[w.status] = (byStatus[w.status] ?? 0) + 1;
  const recentEvents = (await Promise.all(wfs.slice(0, 5).map((w) => repo.listEvents(w.id, 5).then((evs) => evs.map((e) => ({ ...e, workflowName: w.name })))))).flat().sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 15);
  const pending = workloads.value.filter((w) => !w.status?.conditions?.some((x) => x.type === 'Admitted' && x.status === 'True') && !w.status?.conditions?.some((x) => x.type === 'Finished' && x.status === 'True')).length;
  return {
    features: {
      eks: Boolean(c.eks),
      slurm: Boolean(c.slurm),
      amp: Boolean(c.eks?.ampWorkspaceId),
      mlflow: Boolean(c.groot?.mlflowTrackingServerArn),
      pipeline: Boolean(c.groot?.pipelineName),
      dcv: Boolean(c.dcv),
      fsx: Boolean(c.eks?.fsxFileSystemId),
    },
    clusters: clusters.value,
    nodes: {
      total: nodes.value.length,
      ready: nodes.value.filter((n) => n.ready).length,
      gpuCapacity: nodes.value.reduce((a, n) => a + n.gpuCapacity, 0),
      gpuAllocatable: nodes.value.reduce((a, n) => a + n.gpuAllocatable, 0),
      gpuUtilAvg: gpuUtil.value[0]?.value[1],
      error: nodes.error,
    },
    workflows: { total: wfs.length, byStatus, recent: wfs.slice(0, 8) },
    queues: { clusterQueues: cqs.value.length, pendingWorkloads: pending, admitted: cqs.value.reduce((a, q) => a + (q.status?.admittedWorkloads ?? 0), 0) },
    recentEvents,
    cost: session?.role === 'admin' ? costCache?.value : undefined,
    controller: await controllerHealth(),
    errors: [clusters.error, workflows.error, cqs.error, workloads.error].filter(Boolean),
  };
}

/** Lease-based health: true when some replica renewed the CONTROLLER lease recently. */
export async function controllerHealth() {
  const local = controllerStatus();
  try {
    const lease = await getRepo().getLease('CONTROLLER');
    const now = Math.floor(Date.now() / 1000);
    const alive = Boolean(lease?.expires && lease.expires >= now);
    return { ...local, running: alive || local.running, leased: alive, holder: lease?.holder ?? local.holder, leaseExpires: lease?.expires ? new Date(lease.expires * 1000).toISOString() : undefined };
  } catch {
    return local;
  }
}
