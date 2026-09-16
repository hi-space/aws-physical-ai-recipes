import { placementHash } from './hash';
import { TopologyError } from './planner';
import type { TopologyPlan } from './types';
export const TOPOLOGY_ANNOTATION = 'pai.aws/topology-plan';
export function assertPlan(plan: TopologyPlan, workflowId: string, namespace: string, epoch?: string) {
  const { hash, ...content } = plan;
  if (plan.workflowId !== workflowId || plan.namespace !== namespace || plan.epoch !== epoch
    || hash !== placementHash(content)) {
    throw new TopologyError('CONFIG', 'placement plan integrity/workflow/namespace/epoch mismatch');
  }
}
const expressions = (labels: Record<string, string>) => Object.entries(labels).map(([key, value]) => ({ key, operator: 'In', values: [value] }));
/** Hard topology labels live in nodeSelector (ANDed with these alternatives).
 * Kubernetes matchFields In/NotIn requires exactly one value per requirement. */
export function placementAffinity(plan: TopologyPlan | undefined, task: string, excluded: string[] = []) {
  const p = plan?.tasks[task];
  if (plan && !p?.nodes.length) throw new TopologyError('CONFIG', `placement plan lacks eligible nodes for ${task}`);
  if (!p && !excluded.length) return undefined;
  return { nodeAffinity: {
    requiredDuringSchedulingIgnoredDuringExecution: { nodeSelectorTerms: (p ? p.nodes : [undefined]).map(node => ({
      ...(excluded.length ? { matchExpressions: [{ key: 'kubernetes.io/hostname', operator: 'NotIn', values: excluded }] } : {}),
      matchFields: [...(node ? [{ key: 'metadata.name', operator: 'In', values: [node.name] }] : []),
        ...excluded.map(name => ({ key: 'metadata.name', operator: 'NotIn', values: [name] }))],
    })) },
    ...(p?.preferred.length ? { preferredDuringSchedulingIgnoredDuringExecution: p.preferred.map((labels, index) => ({
      weight: Math.max(1, 100 - index * 10), preference: { matchExpressions: expressions(labels) },
    })) } : {}),
  } };
}
/** Admission may narrow placement, but must retain every hard term and scheduler binding. */
export function assertWorkloadPlan(root: import('../ports').JobSet | import('../../k8s/resources').Job, plan: TopologyPlan) {
  if (root.metadata.annotations?.[TOPOLOGY_ANNOTATION] !== plan.hash) throw new TopologyError('PLACEMENT', 'workload topology plan marker mismatch');
  const templates = 'replicatedJobs' in root.spec
    ? (root as import('../ports').JobSet).spec.replicatedJobs.map(r => ({ name: r.name, pod: r.template.spec.template.spec }))
    : [{ name: root.metadata.labels?.['pai.aws/task'] ?? '', pod: (root as import('../../k8s/resources').Job).spec.template.spec }];
  if (templates.length !== Object.keys(plan.tasks).length) throw new TopologyError('PLACEMENT', 'workload topology participant count changed');
  for (const { name, pod } of templates) {
    const p = plan.tasks[name];
    type Term = { matchExpressions?: { key: string; operator: string; values?: string[] }[]; matchFields?: { key: string; operator: string; values?: string[] }[] };
    const affinity = (pod as typeof pod & { affinity?: { nodeAffinity?: { requiredDuringSchedulingIgnoredDuringExecution?: { nodeSelectorTerms?: Term[] } } } }).affinity;
    const terms = affinity?.nodeAffinity?.requiredDuringSchedulingIgnoredDuringExecution?.nodeSelectorTerms;
    if (!p || pod.nodeName || !terms?.length ||
      Object.entries(p.required).some(([key, value]) => pod.nodeSelector?.[key] !== value) ||
      terms.some(term => !term.matchFields?.some(e => e.key === 'metadata.name' && e.operator === 'In' && e.values?.length === 1 && p.nodes.some(n => n.name === e.values![0])))) {
      throw new TopologyError('PLACEMENT', `task ${name}: workload no longer enforces the persisted hard placement`);
    }
  }
}
