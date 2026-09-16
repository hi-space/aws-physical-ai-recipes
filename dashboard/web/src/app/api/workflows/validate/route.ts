import { z } from 'zod';
import { body, route } from '@/server/api';
import { HttpError } from '@/server/errors';
import { parseWorkflowYaml } from '@/server/workflow/template';
import { compileTask, queueForNamespace } from '@/server/workflow/compile';
import { topoOrder } from '@/server/workflow/schema';
export const dynamic = 'force-dynamic';

export const POST = route('viewer', async ({ req }) => {
  const b = await body(req, z.object({ yaml: z.string(), overrides: z.record(z.string(), z.string()).optional() }));
  try {
    const { spec, vars } = parseWorkflowYaml(b.yaml, b.overrides ?? {});
    const ns = spec.workflow.namespace ?? 'rl';
    const manifests = spec.workflow.tasks.map((t) => compileTask(spec, t, { workflowId: 'preview0', owner: 'preview', namespace: ns, queue: queueForNamespace(ns, spec.workflow.queue), priority: spec.workflow.priority, datasetPaths: {}, credentialValues: Object.fromEntries(Object.entries(t.credentials).map(([k, m]) => [k, Object.fromEntries(Object.keys(m).map((e) => [e, '<redacted>']))])) }).job);
    return { ok: true, vars, order: topoOrder(spec), tasks: spec.workflow.tasks.map((t) => ({ name: t.name, resource: spec.workflow.resources[t.resource], image: t.image, inputs: t.inputs, outputs: t.outputs, parallelism: t.parallelism })), manifests };
  } catch (e) {
    if (e instanceof HttpError) return { ok: false, error: e.message, details: e.details };
    throw e;
  }
});
