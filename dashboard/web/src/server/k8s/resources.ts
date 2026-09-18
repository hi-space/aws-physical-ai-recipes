import type { JobSet } from '../workflow/ports';
import { backendConfig as config, currentBackend } from '../backends/context';
import { assertWritableNamespace, K8sError, k8sGetOrNull, k8sJson, k8sRequest } from './client';

export interface Meta { name: string; namespace?: string; uid?: string; labels?: Record<string, string>; annotations?: Record<string, string>; creationTimestamp?: string; deletionTimestamp?: string; ownerReferences?: {kind: string; name: string; uid?: string; controller?: boolean; apiVersion?: string}[] }
export interface K8sList<T> { items: T[]; metadata?: { continue?: string } }
export interface Job {
  metadata: Meta;
  spec: { parallelism?: number; completions?: number; backoffLimit?: number; activeDeadlineSeconds?: number; template: { metadata?: Meta; spec: PodSpec }; suspend?: boolean };
  status?: { active?: number; succeeded?: number; failed?: number; startTime?: string; completionTime?: string; conditions?: { type: string; status: string; reason?: string; message?: string; lastTransitionTime?: string }[] };
}
export interface PodSpec {
  initContainers?: { name: string; image: string }[];
  containers: { name: string; image: string; command?: string[]; args?: string[]; env?: { name: string; value?: string; valueFrom?: unknown }[]; ports?: { name?: string; containerPort: number; protocol?: string }[]; resources?: { requests?: Record<string, string>; limits?: Record<string, string> }; volumeMounts?: { name: string; mountPath: string; subPath?: string; readOnly?: boolean }[]; workingDir?: string }[];
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
  status?: { phase?: string; podIP?: string; hostIP?: string; startTime?: string; reason?: string; message?: string; conditions?: { type: string; status: string; reason?: string; message?: string }[]; containerStatuses?: ContainerStatus[]; initContainerStatuses?: ContainerStatus[] };
}
export interface ContainerStatus { name: string; ready: boolean; restartCount: number; state?: Record<string, { reason?: string; message?: string; exitCode?: number; startedAt?: string; finishedAt?: string }> }
export interface Node {
  metadata: Meta;
  spec?: { taints?: { key: string; value?: string; effect: string }[]; unschedulable?: boolean; providerID?: string };
  status?: { capacity?: Record<string, string>; allocatable?: Record<string, string>; conditions?: { type: string; status: string; reason?: string }[]; nodeInfo?: { kubeletVersion?: string; osImage?: string; kernelVersion?: string }; addresses?: { type: string; address: string }[] };
}
export interface Event { metadata: Meta; type?: string; reason?: string; message?: string; involvedObject?: { kind?: string; name?: string; namespace?: string }; firstTimestamp?: string; lastTimestamp?: string; eventTime?: string; count?: number; source?: { component?: string } }

const q = (o: Record<string, string | number | undefined>) =>
  Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&');

export const listNamespaces = async () => (await k8sJson<K8sList<{ metadata: Meta; status?: { phase?: string } }>>('/api/v1/namespaces')).items;
export const listNodes = async (labelSelector?: string) => listAll<Node>('/api/v1/nodes', { labelSelector });

export async function listJobs(namespace?: string, labelSelector?: string): Promise<Job[]> {
  const base = namespace ? `/apis/batch/v1/namespaces/${namespace}/jobs` : '/apis/batch/v1/jobs';
  return (await k8sJson<K8sList<Job>>(`${base}?${q({ labelSelector, limit: 500 })}`)).items;
}
export const getJob = (ns: string, name: string) => k8sGetOrNull<Job>(`/apis/batch/v1/namespaces/${ns}/jobs/${name}`);

export async function listPods(namespace?: string, labelSelector?: string, fieldSelector?: string): Promise<Pod[]> {
  const base = namespace ? `/api/v1/namespaces/${namespace}/pods` : '/api/v1/pods';
  return listAll<Pod>(base,{labelSelector,fieldSelector});
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
  const existing = await k8sGetOrNull<{ spec?: { volumeName?: string }; status?: { phase?: string } }>(`/api/v1/namespaces/${ns}/persistentvolumeclaims/fsx-pvc`);
  if (currentBackend()?.profile) {
    if (!existing?.spec?.volumeName || existing.status?.phase !== 'Bound') throw new Error('Registered backend requires its preconfigured Bound FSx claim');
    const pv = await k8sGetOrNull<{ spec?: { csi?: { driver?: string; volumeHandle?: string; volumeAttributes?: { dnsname?: string; mountname?: string } }; claimRef?: { namespace?: string; name?: string } } }>(`/api/v1/persistentvolumes/${encodeURIComponent(existing.spec.volumeName)}`);
    if (pv?.spec?.csi?.driver !== 'fsx.csi.aws.com' || pv.spec.csi.volumeHandle !== c.fsxFileSystemId ||
      pv.spec.csi.volumeAttributes?.dnsname !== c.fsxDnsName || pv.spec.csi.volumeAttributes?.mountname !== c.fsxMountName ||
      pv.spec.claimRef?.namespace !== ns || pv.spec.claimRef.name !== 'fsx-pvc') throw new Error('FSx claim does not match the immutable backend storage binding');
    return;
  }
  if (existing) return;
  const { pv, pvc } = fsxPvManifests(ns, c.fsxFileSystemId, c.fsxDnsName, c.fsxMountName);
  if (!(await k8sGetOrNull(`/api/v1/persistentvolumes/fsx-pv-${ns}`))) await k8sJson('/api/v1/persistentvolumes', { method: 'POST', body: pv });
  await k8sJson(`/api/v1/namespaces/${ns}/persistentvolumeclaims`, { method: 'POST', body: pvc });
}

/** Create the workflow ServiceAccount when missing. EKS Pod Identity associations (CDK) bind it to the workflow-pods IAM role. */
export async function ensureServiceAccount(ns: string, name: string): Promise<void> {
  assertWritableNamespace(ns);
  if (await k8sGetOrNull(`/api/v1/namespaces/${ns}/serviceaccounts/${name}`)) return;
  await k8sJson(`/api/v1/namespaces/${ns}/serviceaccounts`, { method: 'POST', body: { apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name, namespace: ns, labels: managedLabels() } } });
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
export async function streamPodLogs(ns: string, pod: string, opts: { container?: string; tailLines?: number; signal?: AbortSignal } = {}): Promise<ReadableStream<Uint8Array>> {
  const res = await k8sRequest(`/api/v1/namespaces/${ns}/pods/${pod}/log?${q({ container: opts.container, tailLines: opts.tailLines ?? 500, follow: 'true', timestamps: 'true' })}`, { headers: { accept: '*/*' }, signal: opts.signal });
  return res.body as ReadableStream<Uint8Array>;
}

export const listAddons = async () => (await import('@aws-sdk/client-eks')).ListAddonsCommand;

/** Follow every Kubernetes continuation token while preserving the exact filters. */
async function listAll<T>(base:string,filters:Record<string,string|undefined>):Promise<T[]> {
  const items:T[]=[];const seen=new Set<string>();let continuation:string|undefined;
  do {
    const page=await k8sJson<K8sList<T>>(`${base}?${q({...filters,limit:500,continue:continuation})}`);
    items.push(...page.items);continuation=page.metadata?.continue;
    if(continuation){if(seen.has(continuation))throw new Error('Kubernetes returned a repeated continuation token');seen.add(continuation);}
  }while(continuation);
  return items;
}
function jobSetPath(ns:string,name?:string):string {
  assertWritableNamespace(ns);
  if(name!==undefined && (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(name) || name.length>63))throw new Error('Invalid JobSet name');
  return `/apis/jobset.x-k8s.io/v1alpha2/namespaces/${ns}/jobsets${name?`/${name}`:''}`;
}
export function getJobSet(ns:string,name:string):Promise<JobSet|null>{return k8sGetOrNull<JobSet>(jobSetPath(ns,name));}
export function listJobSets(ns:string,labelSelector?:string):Promise<JobSet[]>{return listAll<JobSet>(jobSetPath(ns),{labelSelector});}
export async function createJobSet(ns:string,object:unknown):Promise<JobSet>{
  const job=object as JobSet;
  if(job.apiVersion!=='jobset.x-k8s.io/v1alpha2' || job.kind!=='JobSet' || !job.metadata?.name || (job.metadata.namespace && job.metadata.namespace!==ns))throw new Error('JobSet kind or namespace mismatch');
  if(!job.metadata.labels?.['pai.aws/workflow-id'] || !job.metadata.labels?.['pai.aws/epoch'])throw new Error('JobSet ownership labels are required');
  jobSetPath(ns,job.metadata.name);
  return k8sJson<JobSet>(jobSetPath(ns),{method:'POST',body:{...job,metadata:{...job.metadata,namespace:ns,labels:managedLabels(job.metadata.labels)}}});
}
export async function deleteJobSet(ns:string,name:string):Promise<void>{
  try{await k8sJson(jobSetPath(ns,name),{method:'DELETE',body:{propagationPolicy:'Foreground'}});}
  catch(error){if(!(error instanceof K8sError && error.status===404))throw error;}
}
