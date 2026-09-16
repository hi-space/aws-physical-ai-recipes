import type { Pod } from '../../k8s/resources';
import type { TaskSpec, WorkflowSpec } from '../schema';
import { assertPlan } from './affinity';
import { assertInventory, nodeReason } from './planner';
import type { TopologyInventory, TopologyPlan } from './types';
export interface TopologyDiagnostics {
  observedAt: string;
  issue?: string;
  pods: { task: string; pod: string; node?: string; phase?: string; message?: string }[];
}
/** Observations come from actual Pod bindings, never the planner's capacity witness. */
export function observePlacement(plan: TopologyPlan, inventory: TopologyInventory, spec: WorkflowSpec, tasks: TaskSpec[], pods: Pod[], now: Date): TopologyDiagnostics {
  assertPlan(plan, plan.workflowId, plan.namespace, plan.epoch);
  assertInventory(inventory, plan.namespace, plan.queue, now);
  const result: TopologyDiagnostics = { observedAt: inventory.observedAt, pods: [] };
  const issue = (text: string) => { result.issue ??= text; };
  if (inventory.revision !== plan.revision || inventory.levels.length !== plan.levels.length || inventory.levels.some((level, index) => level.key !== plan.levels[index].key || level.label !== plan.levels[index].label)) issue('registered topology changed during the attempt');
  const byName = new Map(inventory.nodes.map(n => [n.name, n]));
  const valid = (name: string, task: TaskSpec): string | undefined => {
    const p = plan.tasks[task.name], allowed = p?.nodes.find(n => n.name === name), node = byName.get(name);
    if (!node || !allowed || node.uid !== allowed.uid) return `node ${name} disappeared/replaced or is outside the persisted placement`;
    const reason = nodeReason(node, task, spec.workflow.resources[task.resource] ?? {});
    if (reason) return `node ${name}: ${reason}`;
    if (Object.entries(p.required).some(([k, v]) => node.labels[k] !== v)) return `node ${name} is outside required topology labels`;
  };
  for (const task of tasks) if (!plan.tasks[task.name]?.nodes.some(n => !valid(n.name, task))) issue(`task ${task.name}: all eligible nodes in the persisted domain are unavailable`);
  for (const pod of pods.slice(0, 256)) {
    const task = tasks.find(t => t.name === pod.metadata.labels?.['pai.aws/task']);
    if (!task) { issue(`pod ${pod.metadata.name}: task identity is absent from placement`); continue; }
    if (pod.metadata.labels?.['pai.aws/epoch'] !== plan.epoch || pod.metadata.labels?.['pai.aws/workflow-id'] !== plan.workflowId) {
      issue(`pod ${pod.metadata.name}: placement epoch/workflow mismatch`); continue;
    }
    const scheduled = pod.status?.conditions?.find(c => c.type === 'PodScheduled' && c.status === 'False');
    result.pods.push({ task: task.name, pod: pod.metadata.name, node: pod.spec.nodeName, phase: pod.status?.phase,
      message: (scheduled ? `${scheduled.reason ?? 'Pending'}: ${scheduled.message ?? ''}` : pod.status?.message)?.slice(0, 300) });
    if (pod.spec.nodeName) {
      const reason = valid(pod.spec.nodeName, task);
      if (reason) issue(`pod ${pod.metadata.name}: ${reason}`);
    }
  }
  if (pods.length > 256) issue('observed pod count exceeds bounded placement inventory');
  return result;
}
