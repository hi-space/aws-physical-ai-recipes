import { z } from 'zod';

const dns1123 = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const duration = /^(\d+)(s|m|h|d)$/;
const quantity = /^\d+(\.\d+)?(m|Mi|Gi|Ti|Ki|M|G|T|k)?$/;

export const durationSchema = z.string().regex(duration, 'duration like 30m, 2h, 1d');
export function durationToSeconds(d: string): number {
  const m = duration.exec(d);
  if (!m) throw new Error(`bad duration ${d}`);
  const n = Number(m[1]);
  return n * ({ s: 1, m: 60, h: 3600, d: 86400 } as Record<string, number>)[m[2]];
}

export const resourceSchema = z
  .object({
    cpu: z.union([z.number(), z.string().regex(quantity)]).optional(),
    memory: z.string().regex(quantity).optional(),
    gpu: z.number().int().min(0).max(8).optional(),
    storage: z.string().regex(quantity).optional(),
    platform: z.string().min(1).optional().describe('instance type node selector, e.g. ml.g5.8xlarge'),
    shm_size: z.string().regex(quantity).optional(),
    efa: z.boolean().optional(),
  })
  .strict();

export const datasetRefSchema = z
  .object({
    name: z.string().regex(dns1123),
    version: z.union([z.literal('latest'), z.number().int().positive()]).default('latest'),
    path: z.string().startsWith('/').optional(),
  })
  .strict();

export const taskInputSchema = z.union([z.object({ task: z.string().regex(dns1123) }).strict(), z.object({ dataset: datasetRefSchema }).strict()]);

export const taskOutputSchema = z.union([
  z.object({ dataset: z.object({ name: z.string().regex(dns1123), path: z.string().min(1), note: z.string().optional() }).strict() }).strict(),
  z.object({ logs: z.string().min(1) }).strict(),
]);

export const taskSchema = z
  .object({
    name: z.string().regex(dns1123).max(40),
    resource: z.string().min(1),
    image: z.string().min(1),
    command: z.array(z.string()).optional(),
    args: z.array(z.string()).optional(),
    working_dir: z.string().optional(),
    environment: z.record(z.string(), z.string()).default({}),
    files: z.array(z.object({ path: z.string().startsWith('/'), contents: z.string(), mode: z.number().int().optional() }).strict()).default([]),
    inputs: z.array(taskInputSchema).default([]),
    outputs: z.array(taskOutputSchema).default([]),
    credentials: z.record(z.string(), z.record(z.string(), z.string())).default({}),
    volumes: z.array(z.string()).default([]),
    parallelism: z.number().int().min(1).max(64).default(1),
    retry: z.object({ max_retries: z.number().int().min(0).max(10).default(0), backoff_seconds: z.number().int().optional() }).strict().default({ max_retries: 0 }),
    timeout: durationSchema.optional(),
    platform: z.string().optional(),
    lead: z.boolean().optional(),
  })
  .strict();

export const workflowSchema = z
  .object({
    workflow: z
      .object({
        name: z.string().regex(dns1123).max(30),
        description: z.string().optional(),
        namespace: z.string().regex(dns1123).optional(),
        queue: z.string().optional(),
        priority: z.string().optional(),
        timeout: z.object({ exec_timeout: durationSchema.default('12h'), queue_timeout: durationSchema.default('6h') }).strict().default({ exec_timeout: '12h', queue_timeout: '6h' }),
        on_failure: z.enum(['cancel_pending', 'continue']).default('cancel_pending'),
        mlflow: z.boolean().default(false).describe('inject MLFLOW_TRACKING_URI/EXPERIMENT for containers that ship the sagemaker-mlflow plugin'),
        resources: z.record(z.string(), resourceSchema).default({}),
        tasks: z.array(taskSchema).min(1).max(50),
        labels: z.record(z.string(), z.string()).optional(),
      })
      .strict(),
    'default-values': z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
    ui: z.unknown().optional(),
  })
  .strict();

export type WorkflowSpec = z.infer<typeof workflowSchema>;
export type TaskSpec = z.infer<typeof taskSchema>;
export type ResourceSpec = z.infer<typeof resourceSchema>;

/** Semantic validation beyond the schema: references and cycles. */
export function validateSpec(spec: WorkflowSpec): string[] {
  const errors: string[] = [];
  const names = new Set<string>();
  for (const t of spec.workflow.tasks) {
    if (names.has(t.name)) errors.push(`duplicate task name ${t.name}`);
    names.add(t.name);
    if (!spec.workflow.resources[t.resource]) errors.push(`task ${t.name}: unknown resource ${t.resource}`);
    for (const i of t.inputs) if ('task' in i && !spec.workflow.tasks.some((x) => x.name === i.task)) errors.push(`task ${t.name}: unknown input task ${i.task}`);
    for (const i of t.inputs) if ('task' in i && i.task === t.name) errors.push(`task ${t.name}: depends on itself`);
  }
  // cycle detection
  const deps = new Map<string, string[]>();
  for (const t of spec.workflow.tasks) deps.set(t.name, t.inputs.flatMap((i) => ('task' in i ? [i.task] : [])));
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
  return errors;
}

/** Topological order (roots first). Assumes validateSpec passed. */
export function topoOrder(spec: WorkflowSpec): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const byName = new Map(spec.workflow.tasks.map((t) => [t.name, t]));
  const visit = (n: string) => {
    if (seen.has(n)) return;
    seen.add(n);
    for (const i of byName.get(n)?.inputs ?? []) if ('task' in i) visit(i.task);
    out.push(n);
  };
  for (const t of spec.workflow.tasks) visit(t.name);
  return out;
}
