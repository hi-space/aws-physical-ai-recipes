import { config } from '../config';
import { assertWritableNamespace, k8sGetOrNull, k8sJson, k8sRequest } from './client';

export interface Meta { name: string; namespace?: string; uid?: string; labels?: Record<string, string>; annotations?: Record<string, string>; creationTimestamp?: string; deletionTimestamp?: string }
export interface K8sList<T> { items: T[]; metadata?: { continue?: string } }
export interface Job {
  metadata: Meta;
  spec: { parallelism?: number; completions?: number; backoffLimit?: number; activeDeadlineSeconds?: number; template: { metadata?: Meta; spec: PodSpec }; suspend?: boolean };
  status?: { active?: number; succeeded?: number; failed?: number; startTime?: string; completionTime?: string; conditions?: { type: string; status: string; reason?: string; message?: string; lastTransitionTime?: string }[] };
}
export interface PodSpec {
  containers: { name: string; image: string; command?: string[]; args?: string[]; env?: { name: string; value?: string; valueFrom?: unknown }[]; resources?: { requests?: Record<string, string>; limits?: Record<string, string> }; volumeMounts?: { name: string; mountPath: string; subPath?: string; readOnly?: boolean }[]; workingDir?: string }[];
  nodeSelector?: Record<string, string>;
  tolerations?: unknown[];
  volumes?: unknown[];
  restartPolicy?: string;
  nodeName?: string;
  terminationGracePeriodSeconds?: number;
}
export interface Pod {
  metadata: Meta;
  spec: PodSpec;
  status?: { phase?: string; podIP?: string; hostIP?: string; startTime?: string; reason?: string; message?: string; conditions?: { type: string; status: string; reason?: string; message?: string }[]; containerStatuses?: { name: string; ready: boolean; restartCount: number; state?: Record<string, { reason?: string; message?: string; exitCode?: number; startedAt?: string; finishedAt?: string }> }[] };
}
export interface Node {
  metadata: Meta;
  status?: { capacity?: Record<string, string>; allocatable?: Record<string, string>; conditions?: { type: string; status: string; reason?: string }[]; nodeInfo?: { kubeletVersion?: string; osImage?: string; kernelVersion?: string }; addresses?: { type: string; address: string }[] };
  spec?: { taints?: { key: string; value?: string; effect: string }[]; unschedulable?: boolean };
}
export interface Event { metadata: Meta; type?: string; reason?: string; message?: string; involvedObject?: { kind?: string; name?: string; namespace?: string }; firstTimestamp?: string; lastTimestamp?: string; eventTime?: string; count?: number; source?: { component?: string } }

const q = (o: Record<string, string | number | undefined>) =>
  Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&');

export const listNamespaces = async () => (await k8sJson<K8sList<{ metadata: Meta; status?: { phase?: string } }>>('/api/v1/namespaces')).items;
export const listNodes = async () => (await k8sJson<K8sList<Node>>('/api/v1/nodes')).items;

export async function listJobs(namespace?: string, labelSelector?: string): Promise<Job[]> {
  const base = namespace ? `/apis/batch/v1/namespaces/${namespace}/jobs` : '/apis/batch/v1/jobs';
  return (await k8sJson<K8sList<Job>>(`${base}?${q({ labelSelector, limit: 500 })}`)).items;
}
export const getJob = (ns: string, name: string) => k8sGetOrNull<Job>(`/apis/batch/v1/namespaces/${ns}/jobs/${name}`);

export async function listPods(namespace?: string, labelSelector?: string, fieldSelector?: string): Promise<Pod[]> {
  const base = namespace ? `/api/v1/namespaces/${namespace}/pods` : '/api/v1/pods';
  return (await k8sJson<K8sList<Pod>>(`${base}?${q({ labelSelector, fieldSelector, limit: 500 })}`)).items;
}
export const getPod = (ns: string, name: string) => k8sGetOrNull<Pod>(`/api/v1/namespaces/${ns}/pods/${name}`);

export async function listEvents(namespace?: string, involvedName?: string, limit = 200): Promise<Event[]> {
  const base = namespace ? `/api/v1/namespaces/${namespace}/events` : '/api/v1/events';
  const fieldSelector = involvedName ? `involvedObject.name=${involvedName}` : undefined;
  const items = (await k8sJson<K8sList<Event>>(`${base}?${q({ fieldSelector, limit })}`)).items;
  return items.sort((a, b) => ts(b).localeCompare(ts(a)));
}
export const ts = (e: Event) => e.lastTimestamp ?? e.eventTime ?? e.firstTimestamp ?? e.metadata.creationTimestamp ?? '';

export async function ensureNamespace(ns: string): Promise<void> {
  assertWritableNamespace(ns);
  const existing = await k8sGetOrNull(`/api/v1/namespaces/${ns}`);
  if (existing) return;
  if (ns.startsWith('hyperpod-ns-')) throw new Error(`${ns} must be created by HyperPod task governance (compute quota)`);
  await k8sJson('/api/v1/namespaces', { method: 'POST', body: { apiVersion: 'v1', kind: 'Namespace', metadata: { name: ns, labels: managedLabels() } } });
}

export function managedLabels(extra: Record<string, string> = {}): Record<string, string> {
  return { 'app.kubernetes.io/managed-by': 'physical-ai-dashboard', ...extra };
}

/** Static FSx for Lustre PV + PVC, identical to hyperpod-training/k8s-templates/fsx-pvc.yaml. */
export function fsxPvManifests(ns: string, fsId: string, dnsName: string, mountName: string, capacityGi = 1200) {
  const pv = {
    apiVersion: 'v1',
    kind: 'PersistentVolume',
    metadata: { name: `fsx-pv-${ns}`, labels: managedLabels() },
    spec: {
      capacity: { storage: `${capacityGi}Gi` },
      volumeMode: 'Filesystem',
      accessModes: ['ReadWriteMany'],
      mountOptions: ['flock'],
      persistentVolumeReclaimPolicy: 'Retain',
      storageClassName: 'fsx-sc',
      csi: { driver: 'fsx.csi.aws.com', volumeHandle: fsId, volumeAttributes: { dnsname: dnsName, mountname: mountName } },
      claimRef: { namespace: ns, name: 'fsx-pvc' },
    },
  };
  const pvc = {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: { name: 'fsx-pvc', namespace: ns, labels: managedLabels() },
    spec: { accessModes: ['ReadWriteMany'], storageClassName: 'fsx-sc', resources: { requests: { storage: `${capacityGi}Gi` } }, volumeName: `fsx-pv-${ns}` },
  };
  return { pv, pvc };
}

export async function ensureFsxPvc(ns: string): Promise<void> {
  const c = config().eks;
  if (!c?.fsxFileSystemId || !c.fsxDnsName || !c.fsxMountName) throw new Error('FSx for Lustre is not configured');
  const existing = await k8sGetOrNull(`/api/v1/namespaces/${ns}/persistentvolumeclaims/fsx-pvc`);
  if (existing) return;
  const { pv, pvc } = fsxPvManifests(ns, c.fsxFileSystemId, c.fsxDnsName, c.fsxMountName);
  if (!(await k8sGetOrNull(`/api/v1/persistentvolumes/fsx-pv-${ns}`))) await k8sJson('/api/v1/persistentvolumes', { method: 'POST', body: pv });
  await k8sJson(`/api/v1/namespaces/${ns}/persistentvolumeclaims`, { method: 'POST', body: pvc });
}

export async function createJob(ns: string, job: unknown): Promise<Job> {
  assertWritableNamespace(ns);
  return k8sJson<Job>(`/apis/batch/v1/namespaces/${ns}/jobs`, { method: 'POST', body: job });
}
export async function deleteJob(ns: string, name: string): Promise<void> {
  assertWritableNamespace(ns);
  try {
    await k8sJson(`/apis/batch/v1/namespaces/${ns}/jobs/${name}`, { method: 'DELETE', body: { propagationPolicy: 'Background' } });
  } catch (e) {
    if (!(e instanceof Error && /404|not found/i.test(e.message))) throw e;
  }
}
export async function upsertConfigMap(ns: string, name: string, data: Record<string, string>, labels: Record<string, string>): Promise<void> {
  assertWritableNamespace(ns);
  const body = { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name, namespace: ns, labels: managedLabels(labels) }, data };
  const existing = await k8sGetOrNull(`/api/v1/namespaces/${ns}/configmaps/${name}`);
  if (existing) await k8sJson(`/api/v1/namespaces/${ns}/configmaps/${name}`, { method: 'PUT', body });
  else await k8sJson(`/api/v1/namespaces/${ns}/configmaps`, { method: 'POST', body });
}
export async function upsertSecret(ns: string, name: string, data: Record<string, string>, labels: Record<string, string>): Promise<void> {
  assertWritableNamespace(ns);
  const enc: Record<string, string> = {};
  for (const [k, v] of Object.entries(data)) enc[k] = Buffer.from(v, 'utf8').toString('base64');
  const body = { apiVersion: 'v1', kind: 'Secret', type: 'Opaque', metadata: { name, namespace: ns, labels: managedLabels(labels) }, data: enc };
  const existing = await k8sGetOrNull(`/api/v1/namespaces/${ns}/secrets/${name}`);
  if (existing) await k8sJson(`/api/v1/namespaces/${ns}/secrets/${name}`, { method: 'PUT', body });
  else await k8sJson(`/api/v1/namespaces/${ns}/secrets`, { method: 'POST', body });
}
export async function deleteByLabel(ns: string, kind: 'configmaps' | 'secrets' | 'deployments' | 'services', labelSelector: string): Promise<void> {
  assertWritableNamespace(ns);
  const base = kind === 'deployments' ? `/apis/apps/v1/namespaces/${ns}/${kind}` : `/api/v1/namespaces/${ns}/${kind}`;
  const list = await k8sJson<K8sList<{ metadata: Meta }>>(`${base}?labelSelector=${encodeURIComponent(labelSelector)}`);
  for (const it of list.items) await k8sJson(`${base}/${it.metadata.name}`, { method: 'DELETE' });
}
export async function readSecret(ns: string, name: string): Promise<Record<string, string>> {
  const s = await k8sJson<{ data?: Record<string, string> }>(`/api/v1/namespaces/${ns}/secrets/${name}`);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(s.data ?? {})) out[k] = Buffer.from(v, 'base64').toString('utf8');
  return out;
}
export async function applyDeployment(ns: string, body: unknown, name: string): Promise<void> {
  assertWritableNamespace(ns);
  const path = `/apis/apps/v1/namespaces/${ns}/deployments`;
  if (await k8sGetOrNull(`${path}/${name}`)) await k8sJson(`${path}/${name}`, { method: 'PUT', body });
  else await k8sJson(path, { method: 'POST', body });
}
export async function applyService(ns: string, body: unknown, name: string): Promise<void> {
  assertWritableNamespace(ns);
  const path = `/api/v1/namespaces/${ns}/services`;
  if (!(await k8sGetOrNull(`${path}/${name}`))) await k8sJson(path, { method: 'POST', body });
}
export async function getDeployment(ns: string, name: string) {
  return k8sGetOrNull<{ metadata: Meta; status?: { readyReplicas?: number; availableReplicas?: number } }>(`/apis/apps/v1/namespaces/${ns}/deployments/${name}`);
}

export async function podLogs(ns: string, pod: string, opts: { container?: string; tailLines?: number; sinceSeconds?: number; previous?: boolean } = {}): Promise<string> {
  const res = await k8sRequest(`/api/v1/namespaces/${ns}/pods/${pod}/log?${q({ container: opts.container, tailLines: opts.tailLines ?? 2000, sinceSeconds: opts.sinceSeconds, previous: opts.previous ? 'true' : undefined, timestamps: 'true' })}`, {
    headers: { accept: '*/*' },
  });
  return res.text();
}
export async function streamPodLogs(ns: string, pod: string, opts: { container?: string; tailLines?: number } = {}): Promise<ReadableStream<Uint8Array>> {
  const res = await k8sRequest(`/api/v1/namespaces/${ns}/pods/${pod}/log?${q({ container: opts.container, tailLines: opts.tailLines ?? 500, follow: 'true', timestamps: 'true' })}`, { headers: { accept: '*/*' } });
  return res.body as ReadableStream<Uint8Array>;
}

export const listAddons = async () => (await import('@aws-sdk/client-eks')).ListAddonsCommand;
