import { performance } from 'node:perf_hooks';
import { placementHash } from './hash';
import type { ResourceSpec, TaskSpec, WorkflowSpec } from '../schema';
import type { TaskPlacement, TopologyInventory, TopologyNode, TopologyPlan } from './types';
export class TopologyError extends Error {
  constructor(readonly code: 'CONFIG' | 'STALE' | 'NO_FIT' | 'SEARCH_LIMIT' | 'PLACEMENT', message: string) {
    super(`Topology ${code}: ${message}`);
  }
}
const reject = (message: string): never => { throw new TopologyError('CONFIG', message); };
export function assertInventory(i: TopologyInventory, namespace: string, queue: string | undefined, now: Date) {
  if (!queue || ['none', 'auto'].includes(queue)) reject('native topology requires an explicit admission queue');
  if (i.namespace !== namespace || i.queue !== queue) reject('inventory namespace/admission queue mismatch');
  if (!i.revision || !i.levels.length || i.levels.length > 8 || new Set(i.levels.map(l => l.key)).size !== i.levels.length || new Set(i.levels.map(l => l.label)).size !== i.levels.length) reject('invalid topology registration revision/hierarchy');
  const age = now.getTime() - Date.parse(i.observedAt);
  if (!Number.isFinite(age) || age < -5000 || age > 30000) throw new TopologyError('STALE', 'node inventory must be observed within 30 seconds');
  if (i.nodes.length > 256 || new Set(i.nodes.map(n => n.name)).size !== i.nodes.length) reject('inventory must contain at most 256 unique nodes');
  if (i.nodes.some(n => !n.uid || !n.name || Object.values(n.available).some(v => !Number.isFinite(v) || v < 0))) reject('node UID/name or available resource inventory is invalid');
}
export function quantity(value: string | number): number {
  const m = /^(\d+(?:\.\d+)?)(n|u|m|Ki|Mi|Gi|Ti|Pi|Ei|k|K|M|G|T|P|E|e[+-]?\d+)?$/.exec(String(value));
  if (!m) reject(`unsupported Kubernetes resource quantity ${value}`);
  const suffix = m![2] ?? '';
  const scales: Record<string, number> = { '': 1, n: 1e-9, u: 1e-6, m: 1e-3, k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18 };
  const scale = suffix.endsWith('i') ? 1024 ** ('KMGTPE'.indexOf(suffix[0]) + 1) : suffix.startsWith('e') ? 10 ** Number(suffix.slice(1)) : scales[suffix];
  const n = Number(m![1]) * scale;
  if (!Number.isFinite(n)) reject(`resource quantity out of range ${value}`);
  return n;
}
export function demand(resource: ResourceSpec): Record<string, number> {
  return { cpu: quantity(resource.cpu ?? 0), memory: quantity(resource.memory ?? 0),
    'ephemeral-storage': quantity(resource.storage ?? 0), 'nvidia.com/gpu': resource.gpu ?? 0,
    'vpc.amazonaws.com/efa': resource.efa ? 1 : 0, pods: 1 };
}
export function nodeReason(node: TopologyNode, task: TaskSpec, res: ResourceSpec): string | undefined {
  if (node.unavailableReason) return node.unavailableReason;
  if (!node.ready || node.unschedulable) return 'not Ready/schedulable';
  if (node.labels['sagemaker.amazonaws.com/node-health-status'] !== 'Schedulable') return 'HyperPod health label is not Schedulable';
  if (res.nodesExcluded?.some(name => name === node.name || name === node.labels['kubernetes.io/hostname'])) return 'nodesExcluded';
  const platform = task.platform ?? res.platform;
  if (platform && node.labels['node.kubernetes.io/instance-type'] !== platform) return `platform ${platform} mismatch`;
  const taint = node.taints.find(t => ['NoSchedule', 'NoExecute'].includes(t.effect) && !(res.gpu && t.key === 'nvidia.com/gpu' && t.effect === 'NoSchedule'));
  if (taint) return `untolerated ${taint.key}:${taint.effect}`;
}
interface Constraint { id: string; level: number; required: boolean; description: string }
interface Member { task: TaskSpec; constraints: Constraint[]; nodes: TopologyNode[]; demand: Record<string, number> }
const matches = (n: TopologyNode, labels: Record<string, string>) => Object.entries(labels).every(([k, v]) => n.labels[k] === v);
const canonical = (labels: Record<string, string>) => JSON.stringify(labels);
export function planTopology(input: { spec: WorkflowSpec; tasks: TaskSpec[]; inventory: TopologyInventory; namespace: string;
  queue?: string; workflowId: string; epoch: string; now: Date; maxSearch?: number }): TopologyPlan {
  const { spec, tasks, inventory: i } = input;
  assertInventory(i, input.namespace, input.queue, input.now);
  const registry = new Map(i.levels.map((l, n) => [l.key, n]));
  const groups = new Map<string, { constraint: Constraint; tasks: TaskSpec[] }>();
  const constraints = new Map<string, Constraint[]>();
  for (const task of spec.workflow.tasks) {
    const entries = spec.workflow.resources[task.resource]?.topology ?? [];
    if (new Set(entries.map(e => e.key)).size !== entries.length) reject(`task ${task.name} repeats a topology key`);
    for (const e of entries) if (!registry.has(e.key)) reject(`unregistered topology key ${e.key} for task ${task.name}`);
    const ordered = [...entries].sort((a, b) => registry.get(a.key)! - registry.get(b.key)!);
    const path: [string, string][] = [];
    constraints.set(task.name, ordered.map(e => {
      path.push([e.key, e.group]);
      const id = JSON.stringify(path), required = e.requirementType === 'required';
      const c = { id, level: registry.get(e.key)!, required, description: path.map(([k, g]) => `${k}/${g}`).join(' > ') };
      const prev = groups.get(id);
      if (prev && prev.constraint.required !== required) reject(`mixed required/preferred modes for ${c.description}`);
      groups.set(id, { constraint: c, tasks: [...(prev?.tasks ?? []), task] });
      return c;
    }));
  }
  const names = new Set(tasks.map(t => t.name));
  for (const { constraint, tasks: members } of groups.values()) {
    if (members.some(t => names.has(t.name)) && members.some(t => !names.has(t.name))) reject(`co-location needs a single admission unit: ${constraint.description} spans ${members.map(t => t.name).join(', ')}`);
  }
  if (tasks.some(t => t.topology) || spec.workflow.groups?.some(g => g.topology && g.tasks.some(t => names.has(t.name)))) reject('native resource.topology cannot be combined with legacy task/group topology in one admission unit');
  if (!tasks.some(t => constraints.get(t.name)?.length)) reject('placement request contains no native topology constraints');
  if (tasks.reduce((n, t) => n + t.parallelism, 0) > 128) reject('native placement supports at most 128 participants per admission unit');
  const domain = (node: TopologyNode, level: number) => Object.fromEntries(i.levels.slice(0, level + 1).map(l => [l.label, node.labels[l.label]]));
  const diagnostics: string[] = [];
  const members: Member[] = tasks.map(task => {
    const res = spec.workflow.resources[task.resource] ?? {}, cs = constraints.get(task.name)!;
    const needLabels = i.levels.slice(0, Math.max(-1, ...cs.map(c => c.level)) + 1);
    const requested = demand(res);
    const nodes = i.nodes.filter(node => {
      const missing = needLabels.find(l => !node.labels[l.label]);
      const reason = nodeReason(node, task, res) ?? (missing ? `missing registered label ${missing.label}` : undefined)
        ?? Object.entries(requested).find(([key, value]) => (node.available[key] ?? 0) + 1e-9 < value)?.[0];
      if (reason && diagnostics.length < 40) diagnostics.push(`${task.name}: node ${node.name}: ${reason}`);
      return !reason;
    }).sort((a, b) => a.name.localeCompare(b.name));
    return { task, constraints: cs, demand: requested, nodes };
  });
  const participants = members.flatMap(m => Array.from({ length: m.task.parallelism }, (_, replica) => ({ ...m, replica })))
    .sort((a, b) => a.nodes.length - b.nodes.length || b.demand['nvidia.com/gpu'] - a.demand['nvidia.com/gpu']);
  if (input.maxSearch !== undefined && (!Number.isSafeInteger(input.maxSearch) || input.maxSearch < 1)) reject('search limit must be a positive integer');
  const maxSearch = Math.min(50000, input.maxSearch ?? 20000);
  function solve(preferred: boolean) {
    const usage = new Map<string, Record<string, number>>(), bindings = new Map<string, string>();
    const assignment: TopologyNode[] = [];
    let visits = 0, exhausted = false;
    const deadline = performance.now() + 500;
    const overBudget = () => ++visits > maxSearch || performance.now() > deadline;
    function visit(index: number): boolean {
      if (overBudget()) { exhausted = true; return false; }
      if (index === participants.length) return true;
      const p = participants[index], cs = p.constraints.filter(c => c.required || preferred);
      for (const node of p.nodes) {
        if (overBudget()) { exhausted = true; return false; }
        const used = usage.get(node.name) ?? {};
        if (Object.entries(p.demand).some(([k, v]) => (used[k] ?? 0) + v > (node.available[k] ?? 0) + 1e-9)) continue;
        if (cs.some(c => bindings.has(c.id) && bindings.get(c.id) !== canonical(domain(node, c.level)))) continue;
        const added = cs.filter(c => !bindings.has(c.id));
        for (const c of added) bindings.set(c.id, canonical(domain(node, c.level)));
        usage.set(node.name, Object.fromEntries(Object.entries(p.demand).map(([k, v]) => [k, (used[k] ?? 0) + v])));
        assignment[index] = node;
        if (visit(index + 1)) return true;
        usage.set(node.name, used);
        for (const c of added) bindings.delete(c.id);
        if (exhausted) break;
      }
      return false;
    }
    return { found: visit(0), exhausted, assignment };
  }
  const hasPreferred = members.some(m => m.constraints.some(c => !c.required));
  let result = solve(hasPreferred);
  if (!result.found && hasPreferred) result = solve(false); // Hard search has its own budget.
  if (!result.found) throw new TopologyError(result.exhausted ? 'SEARCH_LIMIT' : 'NO_FIT', result.exhausted
    ? `bounded placement search exceeded ${maxSearch} steps or 500ms; no unsatisfiability claim`
    : `no feasible placement in current registered node capacity; ${diagnostics.join('; ') || 'combined participant requests/co-location exceed available domains'}`);
  const targets = new Map<string, Record<string, string>>(), observed = new Map<string, Set<string>>();
  participants.forEach((p, index) => p.constraints.forEach(c => {
    const d = domain(result.assignment[index], c.level);
    if (!targets.has(c.id)) targets.set(c.id, d);
    const seen = observed.get(c.id) ?? new Set<string>(); seen.add(canonical(d)); observed.set(c.id, seen);
  }));
  const placements: Record<string, TaskPlacement> = {};
  for (const member of members) {
    const required = Object.assign({}, ...member.constraints.filter(c => c.required).map(c => targets.get(c.id)));
    placements[member.task.name] = { required, preferred: member.constraints.filter(c => !c.required).map(c => targets.get(c.id)!),
      nodes: member.nodes.filter(n => matches(n, required)).map(n => ({ name: n.name, uid: n.uid })) };
  }
  const plan: Omit<TopologyPlan, 'hash'> = { schema: 1, workflowId: input.workflowId, epoch: input.epoch, namespace: i.namespace, queue: i.queue,
    revision: i.revision, observedAt: i.observedAt, levels: i.levels, tasks: placements,
    witness: participants.map((p, index) => ({ task: p.task.name, replica: p.replica, node: result.assignment[index].name })),
    relaxed: [...groups.values()].filter(g => !g.constraint.required && (observed.get(g.constraint.id)?.size ?? 0) > 1).map(g => g.constraint.description), diagnostics };
  // Keep the durable ledger item comfortably below DynamoDB's per-item bound.
  if (Buffer.byteLength(JSON.stringify(plan)) > 160000) reject('placement plan exceeds 160KB; reduce participant/node count');
  return { ...plan, hash: placementHash(plan) };
}
