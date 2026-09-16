import { assertEnvironment, assertInjectionPath, assertSafePath, exitRanges } from './validation';
import { z } from 'zod';
const dns1123 = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const duration = /^(\d+)(s|m|h|d)$/;
const quantity = /^\d+(\.\d+)?(m|Mi|Gi|Ti|Ki|M|G|T|k)?$/;
export const durationSchema = z.string().regex(duration, 'duration like 30m, 2h, 1d').refine(v => Number(duration.exec(v)?.[1]) > 0, 'duration must be positive');
export function durationToSeconds(d: string): number {
  const m = duration.exec(d);
  if (!m) throw new Error(`bad duration ${d}`);
  const n = Number(m[1]);
  return n * ({
    s: 1,
    m: 60,
    h: 3600,
    d: 86400
  } as Record<string, number>)[m[2]];
}
export const resourceSchema = z.object({
  cpu: z.union([z.number(), z.string().regex(quantity)]).optional(),
  memory: z.string().regex(quantity).optional(),
  gpu: z.number().int().min(0).max(8).optional(),
  storage: z.string().regex(quantity).optional(),
  platform: z.string().min(1).optional().describe('instance type node selector, e.g. ml.g5.8xlarge'),
  shm_size: z.string().regex(quantity).optional(),
  efa: z.boolean().optional(),
  nodesExcluded: z.array(z.string().min(1)).optional(),
  topology: z.array(z.object({
    key: z.string().min(1),
    group: z.string().min(1).default('default'),
    requirementType: z.enum(['required', 'preferred']).default('required')
  }).strict()).optional()
}).strict();
export const datasetRefSchema = z.object({
  name: z.string().regex(dns1123),
  version: z.union([z.literal('latest'), z.number().int().positive()]).default('latest'),
  path: z.string().startsWith('/').optional()
}).strict();
export const taskInputSchema = z.union([z.object({
  task: z.string().regex(dns1123)
}).strict(), z.object({
  dataset: datasetRefSchema
}).strict()]);
export const taskOutputSchema = z.union([z.object({
  dataset: z.object({
    name: z.string().refine((name) => {
      const resolved = name.replace(/\{\{\s*workflow_id\s*\}\}/g, 'a'.repeat(16));
      return resolved.length <= 60 && dns1123.test(resolved);
    }, 'dataset output name must be DNS-1123; {{workflow_id}} is allowed for run-scoped outputs'),
    path: z.string().min(1),
    note: z.string().optional()
  }).strict()
}).strict(), z.object({
  logs: z.string().min(1)
}).strict()]);
export const taskSchema = z.object({
  name: z.string().regex(dns1123).max(40),
  resource: z.string().min(1).default('default'),
  image: z.string().min(1),
  command: z.array(z.string()).optional(),
  args: z.array(z.string()).optional(),
  working_dir: z.string().optional(),
  ports: z.array(z.object({
    name: z.string().regex(/^[a-z][a-z0-9-]{0,14}$/),
    containerPort: z.number().int().min(1).max(65535),
    protocol: z.enum(['TCP', 'UDP']).default('TCP'),
  }).strict()).max(16).default([]),
  environment: z.record(z.string(), z.string()).default({}),
  files: z.array(z.object({
    path: z.string().startsWith('/'),
    contents: z.string(),
    mode: z.number().int().min(0).max(0o777).optional()
  }).strict()).default([]),
  inputs: z.array(taskInputSchema).default([]),
  outputs: z.array(taskOutputSchema).default([]),
  credentials: z.record(z.string(), z.record(z.string(), z.string())).default({}),
  volumes: z.array(z.string()).default([]),
  parallelism: z.number().int().min(1).max(64).default(1),
  retry: z.object({
    max_retries: z.number().int().min(0).max(10).default(0),
    backoff_seconds: z.number().int().min(1).max(3600).optional()
  }).strict().default({
    max_retries: 0
  }),
  timeout: durationSchema.optional(),
  platform: z.string().optional(),
  lead: z.boolean().optional(),
  group: z.string().regex(dns1123).optional(),
  exitActions: z.object({
    COMPLETE: z.union([z.string(), z.number()]).optional(),
    FAIL: z.union([z.string(), z.number()]).optional(),
    RESCHEDULE: z.union([z.string(), z.number()]).optional()
  }).strict().optional(),
  checkpoint: z.array(z.object({
    path: z.string(),
    url: z.union([z.literal('auto'), z.string().startsWith('s3://')]),
    frequency: z.preprocess(v => typeof v === 'number' || typeof v === 'string' && /^\d+$/.test(v) ? `${v}s` : v, durationSchema),
    regex: z.string().optional()
  }).strict()).max(64).optional(),
  topology: z.object({
    key: z.string().min(1),
    mode: z.enum(['required', 'preferred']).default('required')
  }).strict().optional()
}).strict();
const timeouts = z.preprocess(value => {
  if (!value || typeof value !== 'object') return value;
  const v = value as Record<string, unknown>;
  const {
    exec,
    queue,
    start,
    ...rest
  } = v;
  return {
    ...rest,
    ...(exec !== undefined ? {
      exec_timeout: exec
    } : {}),
    ...(queue !== undefined ? {
      queue_timeout: queue
    } : {}),
    ...(start !== undefined ? {
      start_timeout: start
    } : {})
  };
}, z.object({
  exec_timeout: durationSchema.default('12h'),
  queue_timeout: durationSchema.default('6h'),
  start_timeout: durationSchema.default('10m')
}).strict());
export const groupSchema = z.object({
  name: z.string().regex(dns1123).max(30),
  barrier: z.boolean().default(true),
  ignoreNonleadStatus: z.boolean().default(true),
  tasks: z.array(taskSchema).min(1).max(50),
  timeout: timeouts.optional(),
  retry: z.object({
    max_retries: z.number().int().min(0).max(10).default(0),
    backoff_seconds: z.number().int().min(1).max(3600).optional()
  }).strict().optional(),
  topology: z.object({
    key: z.string().min(1),
    mode: z.enum(['required', 'preferred']).default('required')
  }).strict().optional()
}).strict();
export type GroupSpec = z.infer<typeof groupSchema>;
export const workflowSchema = z.object({
  workflow: z.object({
    name: z.string().regex(dns1123).max(30),
    description: z.string().optional(),
    namespace: z.string().regex(dns1123).optional(),
    queue: z.string().optional(),
    priority: z.string().optional(),
    timeout: timeouts.default({
      exec_timeout: '12h',
      queue_timeout: '6h',
      start_timeout: '10m'
    }),
    on_failure: z.enum(['cancel_pending', 'continue']).default('cancel_pending'),
    mlflow: z.boolean().default(false).describe('inject MLFLOW_TRACKING_URI/EXPERIMENT for containers that ship the sagemaker-mlflow plugin'),
    resources: z.record(z.string(), resourceSchema).default({}),
    tasks: z.array(taskSchema).max(50).default([]),
    groups: z.array(groupSchema).max(50).optional(),
    labels: z.record(z.string(), z.string()).optional()
  }).strict(),
  'default-values': z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  ui: z.unknown().optional()
}).strict().transform(spec => {
  const grouped = spec.workflow.groups?.flatMap(g => g.tasks.map(t => ({
    ...t,
    group: g.name
  }))) ?? [];
  // Idempotent normalization: normalized snapshots contain both lists.
  const tasks = [...spec.workflow.tasks.filter(t => !grouped.some(member => member.name === t.name && t.group === member.group)), ...grouped];
  return {
    ...spec,
    workflow: {
      ...spec.workflow,
      tasks
    }
  };
});
export type WorkflowSpec = z.infer<typeof workflowSchema>;
export type TaskSpec = z.infer<typeof taskSchema>;
export type ResourceSpec = z.infer<typeof resourceSchema>;

/** Semantic validation beyond the schema: references and cycles. */
export function validateSpec(spec: WorkflowSpec): string[] {
  const errors: string[] = [];
  const names = new Set<string>();
  if (!spec.workflow.tasks.length || spec.workflow.tasks.length > 50) errors.push('workflow requires 1–50 total tasks');
  const groupNames = new Set<string>();
  for (const group of spec.workflow.groups ?? []) {
    if (groupNames.has(group.name)) errors.push(`duplicate group ${group.name}`);
    groupNames.add(group.name);
    if (group.tasks.filter(t => t.lead).length !== 1) errors.push(`group ${group.name} requires exactly one lead task`);
    const members = new Set(group.tasks.map(t => t.name));
    for (const t of group.tasks) for (const i of t.inputs) if ('task' in i && members.has(i.task)) errors.push(`group ${group.name}: task completion dependencies inside a concurrent group are unsupported`);
  }
  for (const t of spec.workflow.tasks) {
    if (names.has(t.name)) errors.push(`duplicate task name ${t.name}`);
    names.add(t.name);
    if (!t.command?.length) errors.push(`task ${t.name}: explicit command is required`);
    if (t.group && !groupNames.has(t.group)) errors.push(`task ${t.name}: unknown group ${t.group}`);
    if (t.lead && !t.group) errors.push(`task ${t.name}: lead requires a group`);
    try {
      const portNames = new Set<string>();
      const portNumbers = new Set<string>();
      for (const port of t.ports ?? []) {
        if (port.name === 'pai-files' || port.containerPort === 8077) throw new Error('port 8077 and pai-files are reserved for managed file access');
        if (portNames.has(port.name) || portNumbers.has(`${port.protocol}:${port.containerPort}`)) throw new Error('duplicate task port');
        portNames.add(port.name);
        portNumbers.add(`${port.protocol}:${port.containerPort}`);
      }
      for (const name of Object.keys(t.environment)) assertEnvironment(name);
      const env = new Set(Object.keys(t.environment));
      for (const mapping of Object.values(t.credentials)) for (const name of Object.keys(mapping)) {
        assertEnvironment(name);
        if (env.has(name)) throw new Error(`duplicate environment ${name}`);
        env.add(name);
      }
      const paths = new Set<string>();
      let bytes = 0;
      for (const f of t.files) {
        assertInjectionPath(f.path);
        const key = f.path.replace(/[^A-Za-z0-9._-]/g, '_');
        if (paths.has(key)) throw new Error(`colliding file path ${f.path}`);
        paths.add(key);
        bytes += Buffer.byteLength(f.contents);
      }
      if (bytes > 900_000) throw new Error('injected files exceed ConfigMap size budget');
      for (const i of t.inputs) if ('dataset' in i && i.dataset.path) assertSafePath(i.dataset.path);
      const destinations = new Set<string>();
      for (const c of t.checkpoint ?? []) {
        assertSafePath(c.path.replace(/\{\{\s*output\s*\}\}/g, '/fsx/checkpoint-output'));
        if (c.url !== 'auto' && destinations.has(c.url)) throw new Error('duplicate checkpoint destinations');
        destinations.add(c.url);
      }
      const codes = new Set<number>();
      for (const range of Object.values(t.exitActions ?? {})) if (range !== undefined) for (const code of exitRanges(range)) {
        if (codes.has(code)) throw new Error(`overlapping exitActions at ${code}`);
        codes.add(code);
      }
    } catch (e) {
      errors.push(`task ${t.name}: ${(e as Error).message}`);
    }
    if (!spec.workflow.resources[t.resource]) errors.push(`task ${t.name}: unknown resource ${t.resource}`);
    for (const i of t.inputs) if ('task' in i && !spec.workflow.tasks.some(x => x.name === i.task)) errors.push(`task ${t.name}: unknown input task ${i.task}`);
    for (const i of t.inputs) if ('task' in i && i.task === t.name) errors.push(`task ${t.name}: depends on itself`);
  }
  // cycle detection
  const deps = new Map<string, string[]>();
  for (const t of spec.workflow.tasks) deps.set(t.name, t.inputs.flatMap(i => 'task' in i ? [i.task] : []));
  const state = new Map<string, 0 | 1 | 2>();
  const visit = (n: string, path: string[]): void => {
    const s = state.get(n) ?? 0;
    if (s === 1) {
      errors.push(`dependency cycle: ${[...path, n].join(' → ')}`);
      return;
    }
    if (s === 2) return;
    state.set(n, 1);
    for (const d of deps.get(n) ?? []) if (names.has(d)) visit(d, [...path, n]);
    state.set(n, 2);
  };
  for (const n of names) visit(n, []);
  // Contracted group dependencies can cycle even when the flat task graph is acyclic.
  const unitOf = new Map(spec.workflow.tasks.map(t => [t.name, t.group ? `group:${t.group}` : `task:${t.name}`]));
  const unitDeps = new Map<string, Set<string>>();
  for (const task of spec.workflow.tasks) {
    const unit = unitOf.get(task.name)!;
    if (!unitDeps.has(unit)) unitDeps.set(unit, new Set());
    for (const input of task.inputs) if ('task' in input) {
      const upstream = unitOf.get(input.task);
      if (upstream && upstream !== unit) unitDeps.get(unit)!.add(upstream);
    }
  }
  const visiting = new Set<string>(),
    done = new Set<string>();
  const visitUnit = (unit: string) => {
    if (visiting.has(unit)) {
      errors.push(`group admission dependency cycle at ${unit}`);
      return;
    }
    if (done.has(unit)) return;
    visiting.add(unit);
    for (const parent of unitDeps.get(unit) ?? []) visitUnit(parent);
    visiting.delete(unit);
    done.add(unit);
  };
  for (const unit of unitDeps.keys()) visitUnit(unit);
  const topologies = spec.workflow.tasks.map(t => spec.workflow.resources[t.resource]?.topology).filter(t => t?.length);
  const keys = topologies.map(t => t!.map(v => v.key).sort().join(','));
  if (keys.some(key => key !== keys[0])) errors.push('native topology key sets must match across tasks');
  return errors;
}

/** Topological order (roots first). Assumes validateSpec passed. */
export function topoOrder(spec: WorkflowSpec): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const byName = new Map(spec.workflow.tasks.map(t => [t.name, t]));
  const visit = (n: string) => {
    if (seen.has(n)) return;
    seen.add(n);
    for (const i of byName.get(n)?.inputs ?? []) if ('task' in i) visit(i.task);
    out.push(n);
  };
  for (const t of spec.workflow.tasks) visit(t.name);
  return out;
}
