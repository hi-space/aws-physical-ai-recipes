import { listNodes, listPods, type Node, type Pod } from '../../k8s/resources';
import type { Workflow } from '../../store/types';
import { queueForNamespace } from '../compile';
import { quantity, TopologyError } from './planner';
import type { TopologyInventory, TopologyLevel } from './types';
export interface TopologyRegistration {
  namespace: string;
  queue: string;
  revision: string;
  /** Intersection of the authorized pool and admitted ResourceFlavor selectors. */
  nodeSelector: Record<string, string>;
  levels: TopologyLevel[];
}
interface Readers {
  listNodes(selector: string): Promise<Node[]>;
  listPods(): Promise<Pod[]>;
  now(): Date;
}
type Requests = Record<string, number>;
const add = (a: Requests, b: Requests) => { for (const [k, v] of Object.entries(b)) a[k] = (a[k] ?? 0) + v; return a; };
const max = (a: Requests, b: Requests) => { for (const [k, v] of Object.entries(b)) a[k] = Math.max(a[k] ?? 0, v); return a; };
interface Container { restartPolicy?: string; resources?: { requests?: Record<string, string>; limits?: Record<string, string> } }
function requests(c: Container): Requests {
  // Kubernetes defaults a missing request to its limit, including extended resources.
  return Object.fromEntries(Object.entries({ ...c.resources?.limits, ...c.resources?.requests }).map(([k, v]) => [k, quantity(v)]));
}
function podRequests(p: Pod): Requests {
  const spec = p.spec as Pod['spec'] & { overhead?: Record<string, string>; resources?: unknown; initContainers?: Container[] };
  if (spec.resources) throw new Error('pod-level resources require an updated accounting adapter');
  const regular = p.spec.containers.reduce((sum, c) => add(sum, requests(c)), {} as Requests);
  const sidecars: Requests = {}, initMax: Requests = {};
  for (const c of spec.initContainers ?? []) {
    const r = requests(c);
    if (c.restartPolicy === 'Always') add(sidecars, r);
    max(initMax, c.restartPolicy === 'Always' ? sidecars : add({ ...sidecars }, r));
  }
  const effective = max(add(regular, sidecars), initMax);
  add(effective, Object.fromEntries(Object.entries(spec.overhead ?? {}).map(([k, v]) => [k, quantity(v)])));
  effective.pods = 1;
  return effective;
}
/** Read-only Kubernetes adapter. No registration means no native topology execution. */
export function createTopologyInventory(registrations: TopologyRegistration[], readers: Readers = {
  listNodes, listPods: () => listPods(), now: () => new Date(),
}): (workflow: Workflow, signal: AbortSignal) => Promise<TopologyInventory> {
  const entries = structuredClone(registrations);
  if (new Set(entries.map(r => `${r.namespace}/${r.queue}`)).size !== entries.length) throw new Error('duplicate topology namespace/queue registration');
  for (const r of entries) {
    if (!Object.keys(r.nodeSelector).length || !r.revision || !r.levels.length) throw new Error('topology registration requires pool selector, hierarchy and revision');
    for (const [k, v] of [...Object.entries(r.nodeSelector), ...r.levels.map(l => [l.label, 'label'])]) {
      if (!/^(?:[a-z0-9.-]+\/)?[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(k) || !/^[A-Za-z0-9_.-]+$/.test(v)) throw new Error('invalid topology label selector');
    }
  }
  return async (workflow, signal) => {
    signal.throwIfAborted();
    const queue = queueForNamespace(workflow.namespace, workflow.spec.workflow.queue);
    const r = entries.find(e => e.namespace === workflow.namespace && e.queue === queue);
    if (!r) throw new TopologyError('CONFIG', `topology is not registered for namespace ${workflow.namespace} queue ${queue ?? '(none)'}`);
    const observedAt = readers.now().toISOString();
    const selector = Object.entries(r.nodeSelector).map(([k, v]) => `${k}=${v}`).join(',');
    const [nodeResult, podResult] = await Promise.allSettled([readers.listNodes(selector), readers.listPods()]);
    signal.throwIfAborted();
    if (nodeResult.status === 'rejected') throw nodeResult.reason;
    if (podResult.status === 'rejected') throw podResult.reason;
    const nodes = nodeResult.value.filter(n => Object.entries(r.nodeSelector).every(([k, v]) => n.metadata.labels?.[k] === v));
    const usage = new Map<string, Requests>(), errors = new Map<string, string>();
    for (const p of podResult.value) {
      if (!p.spec.nodeName || ['Succeeded', 'Failed'].includes(p.status?.phase ?? '')) continue;
      try { usage.set(p.spec.nodeName, add(usage.get(p.spec.nodeName) ?? {}, podRequests(p))); }
      catch (e) { errors.set(p.spec.nodeName, `cannot account pod ${p.metadata.name}: ${(e as Error).message}`); }
    }
    return { namespace: r.namespace, queue: r.queue, revision: r.revision, levels: r.levels, observedAt,
      nodes: nodes.map(n => {
        let available: Requests = {}, reason = errors.get(n.metadata.name);
        try {
          if (!n.status?.allocatable?.pods) throw new Error('allocatable pod capacity missing');
          available = Object.fromEntries(Object.entries(n.status.allocatable).map(([k, v]) => [k, Math.max(0, quantity(v) - (usage.get(n.metadata.name)?.[k] ?? 0))]));
        } catch (e) { reason = (e as Error).message; }
        return { name: n.metadata.name, uid: n.metadata.uid ?? '', labels: n.metadata.labels ?? {}, available,
          ready: !n.metadata.deletionTimestamp && n.status?.conditions?.some(c => c.type === 'Ready' && c.status === 'True') === true,
          unschedulable: n.spec?.unschedulable, taints: n.spec?.taints ?? [], ...(reason ? { unavailableReason: reason } : {}) };
      }),
    };
  };
}
