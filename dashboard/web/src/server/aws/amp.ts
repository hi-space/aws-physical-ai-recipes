import { config } from '../config';
import { notConfigured } from '../errors';
import { sigv4Fetch } from './sigv4';

export interface PromSample { metric: Record<string, string>; values: [number, number][] }
export interface PromInstant { metric: Record<string, string>; value: [number, number] }

function base(): string {
  const ws = config().eks?.ampWorkspaceId;
  if (!ws) throw notConfigured('Amazon Managed Prometheus');
  return `https://aps-workspaces.${config().region}.amazonaws.com/workspaces/${ws}/api/v1`;
}

async function call<T>(path: string, params: Record<string, string>): Promise<T> {
  const url = new URL(`${base()}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await sigv4Fetch({ service: 'aps', region: config().region, url: url.toString() });
  const json = (await res.json()) as { status: string; data?: { result: T }; error?: string };
  if (!res.ok || json.status !== 'success') throw new Error(`AMP ${path} failed: ${json.error ?? res.status}`);
  return json.data!.result;
}

export async function queryRange(promql: string, startSec: number, endSec: number, stepSec: number): Promise<PromSample[]> {
  const raw = await call<{ metric: Record<string, string>; values: [number, string][] }[]>('query_range', {
    query: promql,
    start: String(startSec),
    end: String(endSec),
    step: String(stepSec),
  });
  return raw.map((r) => ({ metric: r.metric, values: r.values.map(([t, v]) => [t, Number(v)] as [number, number]) }));
}

export async function queryInstant(promql: string): Promise<PromInstant[]> {
  const raw = await call<{ metric: Record<string, string>; value: [number, string] }[]>('query', { query: promql });
  return raw.map((r) => ({ metric: r.metric, value: [r.value[0], Number(r.value[1])] }));
}

export async function labelValues(label: string): Promise<string[]> {
  return call<string[]>(`label/${encodeURIComponent(label)}/values`, {});
}

/**
 * Allow-listed PromQL builders. The UI sends `{metric, params}`; we never accept
 * raw PromQL from the browser.
 */
export const METRICS: Record<string, (p: Record<string, string>) => string> = {
  gpu_util: (p) => `avg by (Hostname, gpu) (DCGM_FI_DEV_GPU_UTIL${sel(p)})`,
  gpu_mem_used: (p) => `max by (Hostname, gpu) (DCGM_FI_DEV_FB_USED${sel(p)})`,
  gpu_power: (p) => `avg by (Hostname, gpu) (DCGM_FI_DEV_POWER_USAGE${sel(p)})`,
  gpu_temp: (p) => `max by (Hostname, gpu) (DCGM_FI_DEV_GPU_TEMP${sel(p)})`,
  gpu_sm_clock: (p) => `avg by (Hostname, gpu) (DCGM_FI_DEV_SM_CLOCK${sel(p)})`,
  node_cpu: () => `100 - (avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[2m])) * 100)`,
  node_mem: () => `(1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes) * 100`,
  node_net_rx: () => `sum by (instance) (rate(node_network_receive_bytes_total{device!~"lo|veth.*"}[2m]))`,
  pod_cpu: (p) => `sum by (pod) (rate(container_cpu_usage_seconds_total{container!="",${podSel(p)}}[2m]))`,
  pod_mem: (p) => `sum by (pod) (container_memory_working_set_bytes{container!="",${podSel(p)}})`,
  kueue_pending: () => `sum by (cluster_queue) (kueue_pending_workloads)`,
  kueue_admitted: () => `sum by (cluster_queue) (kueue_admitted_active_workloads)`,
  kueue_usage_gpu: () => `sum by (cluster_queue) (kueue_cluster_queue_resource_usage{resource="nvidia.com/gpu"})`,
  kueue_usage_cpu: () => `sum by (cluster_queue) (kueue_cluster_queue_resource_usage{resource="cpu"})`,
  gpu_allocatable: () => `sum(kube_node_status_allocatable{resource="nvidia_com_gpu"})`,
  gpu_requested: () => `sum(kube_pod_container_resource_requests{resource="nvidia_com_gpu"} * on(pod,namespace) group_left kube_pod_status_phase{phase="Running"})`,
  gpu_util_pod: (p) => `avg by (pod, gpu) (DCGM_FI_DEV_GPU_UTIL{${podSel(p, 'pod')}} or DCGM_FI_DEV_GPU_UTIL{${podSel(p, 'exported_pod')}})`,
  gpu_mem_pod: (p) => `max by (pod, gpu) (DCGM_FI_DEV_FB_USED{${podSel(p, 'pod')}} or DCGM_FI_DEV_FB_USED{${podSel(p, 'exported_pod')}})`,
};

function sel(p: Record<string, string>): string {
  const parts: string[] = [];
  if (p.node) parts.push(`Hostname=~"${esc(p.node)}"`);
  return parts.length ? `{${parts.join(',')}}` : '';
}
function podSel(p: Record<string, string>, label = 'pod'): string {
  const parts: string[] = [];
  if (p.pod) parts.push(`${label}=~"${esc(p.pod)}"`);
  if (p.namespace) parts.push(`namespace="${esc(p.namespace)}"`);
  return parts.join(',');
}
function esc(v: string): string {
  return v.replace(/["\\]/g, '');
}
