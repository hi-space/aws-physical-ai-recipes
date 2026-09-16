import { METRICS } from '../aws/amp';
import { badRequest, forbidden } from '../errors';
import type { Project } from '../auth/projects';

/** Namespace and queue selectors come exclusively from the server's project registry. */
export function scopedMetric(metric: string, params: Record<string, string>, project?: Project, clusterQueue?: string) {
  const builder = METRICS[metric];
  if (!builder) throw badRequest(`unknown metric ${metric}`);
  if (!project) return builder(params);
  if (params.namespace && params.namespace !== project.namespace) throw forbidden('다른 프로젝트의 지표를 조회할 수 없습니다.');
  const trusted = { ...params, namespace: project.namespace };
  if (['pod_cpu', 'pod_mem', 'gpu_util_pod', 'gpu_mem_pod'].includes(metric)) return builder(trusted);
  if (metric === 'gpu_util') return METRICS.gpu_util_pod(trusted);
  if (metric === 'gpu_mem_used') return METRICS.gpu_mem_pod(trusted);
  const namespace = JSON.stringify(project.namespace);
  if (metric === 'gpu_requested') return `sum(kube_pod_container_resource_requests{resource="nvidia_com_gpu",namespace=${namespace}} * on(pod,namespace) group_left kube_pod_status_phase{phase="Running",namespace=${namespace}})`;
  const queues: Record<string, [string, string?]> = {
    kueue_pending: ['kueue_pending_workloads'], kueue_admitted: ['kueue_admitted_active_workloads'],
    kueue_usage_gpu: ['kueue_cluster_queue_resource_usage', 'nvidia.com/gpu'],
    kueue_usage_cpu: ['kueue_cluster_queue_resource_usage', 'cpu'],
  };
  if (queues[metric]) {
    if (!clusterQueue) throw badRequest('프로젝트의 연결된 큐를 확인할 수 없습니다.');
    const [name, resource] = queues[metric];
    return `sum by (cluster_queue) (${name}{cluster_queue=${JSON.stringify(clusterQueue)}${resource ? `,resource=${JSON.stringify(resource)}` : ''}})`;
  }
  throw forbidden('이 노드 전체 지표는 플랫폼 관리자에게 제공됩니다.');
}
