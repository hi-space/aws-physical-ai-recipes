import YAML from 'yaml';
import type { TemplateParam } from '@/server/store/types';
import type { RecipeMetadata } from '@/lib/workflow/recipe-metadata';
import type { TemplateDto } from '@/lib/workflow/template-dto';
import type { PortKind } from '@/lib/workflow/ports';

// This module lives in `lib/` so client components can import it. It therefore parses and rewrites
// workflow YAML with the `yaml` package directly and depends only on `import type` declarations —
// never on server runtime modules (`@/server/**` values, config, AWS). The composed YAML is validated
// against the real schema by the caller (POST /api/workflows/validate) and, in tests, by parseWorkflowYaml.

export interface ComposeGraph {
  nodes: { id: string; templateId: string; title: string; params: Record<string, string> }[];
  datasets: { id: string; name: string; version: number }[];
  edges: { from: { node: string; port: string } | { dataset: string }; to: { node: string; param: string } }[];
}

export type ComposeErrorCode =
  | 'cycle'
  | 'kind_mismatch'
  | 'input_bound_twice'
  | 'unknown_template'
  | 'duplicate_slug'
  | 'group_task_chained'
  | 'missing_port';

export interface ComposeError {
  code: ComposeErrorCode;
  message: string;
  nodeId?: string;
  edgeIndex?: number;
}

export interface ComposedWorkflow {
  yaml: string;
  params: TemplateParam[];
  recipe: RecipeMetadata;
  errors: ComposeError[];
}

/** Placeholders resolved by the compiler/runtime, never rewritten as user params (mirrors template.ts). */
const RESERVED = new Set(['output', 'workflow_id', 'task_name', 'replica_index', 'input']);
const PARAM_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
const HOST_RE = /\{\{\s*host:([a-zA-Z0-9_-]+)((?::\d+)?)\s*\}\}/g;

/** Converts a node title to a DNS-1123 label used as the task/group/param prefix. */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    // Whitespace and any dash-like separator (hyphen-minus, en/em dash) collapse to a single hyphen.
    .replace(/[\s\-‐-―]+/g, '-')
    // Drop everything else that is not an ASCII alphanumeric or hyphen.
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ---------------------------------------------------------------------------------------------------
// Raw (unvalidated) YAML shapes — we operate on the parsed document, not the zod-validated spec.
// ---------------------------------------------------------------------------------------------------
type RawInput = { task?: string; dataset?: { name?: string; version?: unknown; path?: string } } & Record<string, unknown>;
type RawOutput = { dataset?: { name?: string; path?: string }; logs?: string } & Record<string, unknown>;
interface RawTask {
  name: string;
  resource?: string;
  group?: string;
  inputs?: RawInput[];
  outputs?: RawOutput[];
  [key: string]: unknown;
}
interface RawGroup {
  name: string;
  tasks: RawTask[];
  [key: string]: unknown;
}
interface RawWorkflow {
  name?: string;
  mlflow?: boolean;
  timeout?: { exec_timeout?: string; queue_timeout?: string; start_timeout?: string } & Record<string, unknown>;
  resources?: Record<string, unknown>;
  tasks?: RawTask[];
  groups?: RawGroup[];
  [key: string]: unknown;
}
interface RawDoc {
  workflow: RawWorkflow;
  'default-values'?: Record<string, unknown>;
  ui?: unknown;
}

const clone = <T>(value: T): T => structuredClone(value);

/** Every task in the document, whether top-level or a group member. */
function allTasks(doc: RawDoc): RawTask[] {
  return [...(doc.workflow.tasks ?? []), ...(doc.workflow.groups ?? []).flatMap((g) => g.tasks ?? [])];
}

/** Recursively rewrite every string value in a JSON-like structure. */
function deepRewriteStrings(value: unknown, fn: (s: string) => string): void {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      if (typeof value[i] === 'string') value[i] = fn(value[i] as string);
      else deepRewriteStrings(value[i], fn);
    }
  } else if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      if (typeof obj[key] === 'string') obj[key] = fn(obj[key] as string);
      else deepRewriteStrings(obj[key], fn);
    }
  }
}

// Task/group/host identifiers keep the DNS-1123 slug (hyphens allowed). Params and their `{{ }}`
// placeholders must be valid workflow variable names ([A-Za-z_][A-Za-z0-9_]*), so their prefix is the
// slug with hyphens folded to underscores.
const paramPrefixOf = (taskSlug: string) => taskSlug.replace(/-/g, '_');

// Room reserved for `-{{workflow_id}}` once the placeholder resolves: schema.ts checks the output name
// with a 16-char run id and caps the result at 60 chars (DNS-1123). `<slug>-<base>-<16-char id>` must fit.
const OUTPUT_NAME_ID_RESERVE = 18; // 16-char id + the two hyphens joining slug, base and id
const OUTPUT_NAME_MAX = 60;
const WORKFLOW_ID_OUTPUT_RE = /^(.*)-(\{\{\s*workflow_id\s*\}\})$/;

/**
 * Namespace an output dataset base name under a node slug so two nodes of the same recipe publish
 * distinct datasets (`<slug>-<base>-{{workflow_id}}`) instead of colliding on one dataset name. The slug
 * is truncated (and trailing hyphens stripped) so the resolved name still satisfies schema.ts's
 * DNS-1123 output-name rule; if there is no room for even one slug char the bare base is kept.
 */
export function namespacedOutput(slug: string, base: string): string {
  const maxSlug = OUTPUT_NAME_MAX - OUTPUT_NAME_ID_RESERVE - base.length;
  const prefix = maxSlug > 0 ? slug.slice(0, maxSlug).replace(/-+$/g, '') : '';
  return prefix ? `${prefix}-${base}` : base;
}

/** Prefix a placeholder-bearing string: params `<paramSlug>_name`, host refs `<taskSlug>-name`. */
function makePlaceholderRewriter(taskSlug: string): (s: string) => string {
  const paramSlug = paramPrefixOf(taskSlug);
  return (s) =>
    s
      .replace(HOST_RE, (_m, name: string, idx: string) => `{{host:${taskSlug}-${name}${idx}}}`)
      .replace(PARAM_RE, (m, name: string) => (RESERVED.has(name) ? m : `{{ ${paramSlug}_${name} }}`));
}

/** Fully prefix one node's parsed document in place: placeholders, task/group names, internal deps. */
function prefixDoc(doc: RawDoc, taskSlug: string): RawDoc {
  const out = clone(doc);
  const paramSlug = paramPrefixOf(taskSlug);
  const rewrite = makePlaceholderRewriter(taskSlug);

  // 1. Placeholders inside tasks, groups and resource definitions.
  deepRewriteStrings(out.workflow.tasks, rewrite);
  deepRewriteStrings(out.workflow.groups, rewrite);
  deepRewriteStrings(out.workflow.resources, rewrite);

  // 2. Structural identifiers (plain names, no placeholders): task/group names and internal task deps.
  for (const group of out.workflow.groups ?? []) group.name = `${taskSlug}-${group.name}`;
  for (const task of allTasks(out)) {
    task.name = `${taskSlug}-${task.name}`;
    if (task.group) task.group = `${taskSlug}-${task.group}`;
    for (const input of task.inputs ?? []) {
      if (typeof input.task === 'string') input.task = `${taskSlug}-${input.task}`;
    }
    // Namespace each run-scoped published dataset under this node's slug so two nodes of the same
    // recipe do not publish the same `<base>-{{workflow_id}}` dataset name (which would collide as
    // versions of one dataset at runtime). Keeps the `{{workflow_id}}` placeholder intact.
    for (const output of task.outputs ?? []) {
      const name = output.dataset?.name;
      if (typeof name !== 'string') continue;
      const match = WORKFLOW_ID_OUTPUT_RE.exec(name);
      if (match) output.dataset!.name = `${namespacedOutput(taskSlug, match[1])}-${match[2]}`;
    }
  }

  // 3. default-values keys mirror the prefixed params.
  const dv = out['default-values'] ?? {};
  out['default-values'] = Object.fromEntries(Object.entries(dv).map(([k, v]) => [`${paramSlug}_${k}`, v]));

  return out;
}

/** The prefixed name of the task in `doc` whose outputs publish `<portName>-{{workflow_id}}`. */
function findProducingTask(doc: RawDoc, portName: string): string | undefined {
  const re = new RegExp(`^${portName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\{\\{\\s*workflow_id\\s*\\}\\}$`);
  for (const task of allTasks(doc)) {
    for (const output of task.outputs ?? []) {
      if (output.dataset && typeof output.dataset.name === 'string' && re.test(output.dataset.name)) return task.name;
    }
  }
  return undefined;
}

/** Duration like `12h` → seconds; unparseable durations count as 0 so real values win the max. */
function durationSeconds(d: string | undefined): number {
  const m = /^(\d+)([smhd])$/.exec(d ?? '');
  if (!m) return 0;
  const factor: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
  return Number(m[1]) * factor[m[2]];
}

function maxDuration(a: string, b: string | undefined): string {
  return durationSeconds(b) > durationSeconds(a) ? (b as string) : a;
}

/** Empty composite recipe returned alongside errors. */
function emptyRecipe(): RecipeMetadata {
  return {
    revision: 'composed',
    readiness: 'image-required',
    verification: 'local-docker',
    prerequisites: [],
    sources: [],
    artifacts: [],
    imageContract: '',
  };
}

/** Compose a workflow from a graph of recipe nodes and dataset connections. Pure; no I/O. */
export function composeWorkflow(graph: ComposeGraph, templates: TemplateDto[]): ComposedWorkflow {
  const errors: ComposeError[] = [];
  const templateMap = new Map(templates.map((t) => [t.id, t]));
  const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));
  const slugOf = (nodeId: string) => slugify(nodeMap.get(nodeId)?.title ?? '');

  // 1. Every node references a known template.
  for (const node of graph.nodes) {
    if (!templateMap.has(node.templateId)) {
      errors.push({ code: 'unknown_template', message: `템플릿 "${node.templateId}"을(를) 찾을 수 없습니다.`, nodeId: node.id });
    }
  }

  // 2. Node title slugs must be unique (they become task-name prefixes).
  const slugOwner = new Map<string, string>();
  for (const node of graph.nodes) {
    const slug = slugify(node.title);
    const owner = slugOwner.get(slug);
    if (owner) {
      errors.push({
        code: 'duplicate_slug',
        message: `중복된 블록 이름 "${slug}" ("${nodeMap.get(owner)?.title}"와 "${node.title}").`,
        nodeId: node.id,
      });
    } else {
      slugOwner.set(slug, node.id);
    }
  }

  // 3. Each target input may be bound by at most one edge.
  const boundBy = new Map<string, number>(); // "<nodeId>/<param>" -> first edge index
  for (let i = 0; i < graph.edges.length; i++) {
    const key = `${graph.edges[i].to.node}/${graph.edges[i].to.param}`;
    if (boundBy.has(key)) {
      errors.push({ code: 'input_bound_twice', message: `입력 "${graph.edges[i].to.param}"이(가) 여러 간선에 연결되었습니다.`, edgeIndex: i });
    } else {
      boundBy.set(key, i);
    }
  }

  // 4. Port validation: target param exists, source port exists, kinds match.
  const datasetMap = new Map(graph.datasets.map((d) => [d.id, d]));
  for (let i = 0; i < graph.edges.length; i++) {
    const edge = graph.edges[i];
    const toNode = nodeMap.get(edge.to.node);
    const toTemplate = toNode ? templateMap.get(toNode.templateId) : undefined;
    const targetPort = toTemplate?.recipe?.ports?.inputs.find((p) => p.param === edge.to.param);
    if (!targetPort) {
      errors.push({ code: 'missing_port', message: `대상 노드에 입력 포트 "${edge.to.param}"이(가) 없습니다.`, edgeIndex: i });
      continue;
    }
    let sourceKind: PortKind | undefined;
    if ('node' in edge.from) {
      const from = edge.from;
      const fromNode = nodeMap.get(from.node);
      const fromTemplate = fromNode ? templateMap.get(fromNode.templateId) : undefined;
      const sourcePort = fromTemplate?.recipe?.ports?.outputs.find((p) => p.name === from.port);
      if (!sourcePort) {
        errors.push({ code: 'missing_port', message: `소스 노드에 출력 포트 "${from.port}"이(가) 없습니다.`, edgeIndex: i });
        continue;
      }
      sourceKind = sourcePort.kind;
    } else {
      // Dataset source: kind is inferred from lineage upstream; unknown lineage is treated as connectable.
      const ds = datasetMap.get(edge.from.dataset);
      if (!ds) {
        errors.push({ code: 'missing_port', message: `데이터셋 소스 "${edge.from.dataset}"을(를) 찾을 수 없습니다.`, edgeIndex: i });
        continue;
      }
      sourceKind = undefined; // unverified — accept into any input (facts over guesses).
    }
    if (sourceKind && sourceKind !== targetPort.kind) {
      errors.push({
        code: 'kind_mismatch',
        message: `포트 종류 불일치: ${sourceKind} → ${targetPort.kind} ("${edge.to.param}").`,
        edgeIndex: i,
      });
    }
  }

  // 5. Cycle detection over node→node edges (independent of the kind checks above).
  const nodeIds = new Set(graph.nodes.map((n) => n.id));
  const outAdj = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  for (const id of nodeIds) {
    outAdj.set(id, []);
    inDegree.set(id, 0);
  }
  for (const edge of graph.edges) {
    if ('node' in edge.from && nodeIds.has(edge.from.node) && nodeIds.has(edge.to.node) && edge.from.node !== edge.to.node) {
      outAdj.get(edge.from.node)!.push(edge.to.node);
      inDegree.set(edge.to.node, (inDegree.get(edge.to.node) ?? 0) + 1);
    }
  }
  const queue = [...nodeIds].filter((id) => (inDegree.get(id) ?? 0) === 0);
  const topoOrder: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    topoOrder.push(id);
    for (const next of outAdj.get(id) ?? []) {
      inDegree.set(next, (inDegree.get(next) ?? 0) - 1);
      if ((inDegree.get(next) ?? 0) === 0) queue.push(next);
    }
  }
  if (topoOrder.length !== nodeIds.size) {
    errors.push({ code: 'cycle', message: '파이프라인에 순환이 있습니다.' });
  }

  if (errors.length) return { yaml: '', params: [], recipe: emptyRecipe(), errors };

  // ------------------------------------------------------------------------------------------------
  // Phase A: prefix each node's document independently.
  // ------------------------------------------------------------------------------------------------
  const prefixed = new Map<string, RawDoc>();
  for (const node of graph.nodes) {
    const template = templateMap.get(node.templateId)!;
    const doc = YAML.parse(template.yaml) as RawDoc;
    prefixed.set(node.id, prefixDoc(doc, slugify(node.title)));
  }

  // ------------------------------------------------------------------------------------------------
  // Phase B: apply edges. Node→node edges rewrite the downstream dataset input to a task dependency
  // and drop the bound param; dataset edges pin default-values and keep the param.
  // ------------------------------------------------------------------------------------------------
  const droppedParams = new Set<string>(); // prefixed param names removed by node→node edges
  const datasetDefaults = new Map<string, string | number>(); // prefixed param name -> pinned default

  for (const edge of graph.edges) {
    const toNode = nodeMap.get(edge.to.node)!;
    const toTemplate = templateMap.get(toNode.templateId)!;
    const toParamSlug = paramPrefixOf(slugify(toNode.title));
    const targetPort = toTemplate.recipe!.ports!.inputs.find((p) => p.param === edge.to.param)!;
    const prefixedParam = `${toParamSlug}_${edge.to.param}`;
    const prefixedVersionParam = targetPort.versionParam ? `${toParamSlug}_${targetPort.versionParam}` : undefined;
    const targetDoc = prefixed.get(edge.to.node)!;
    const paramPlaceholder = new RegExp(`^\\{\\{\\s*${prefixedParam}\\s*\\}\\}$`);

    if ('node' in edge.from) {
      const sourceDoc = prefixed.get(edge.from.node)!;
      const fromNode = nodeMap.get(edge.from.node)!;
      const producer = findProducingTask(sourceDoc, namespacedOutput(slugify(fromNode.title), edge.from.port));
      if (producer) {
        for (const task of allTasks(targetDoc)) {
          if (!task.inputs) continue;
          for (let i = 0; i < task.inputs.length; i++) {
            const input = task.inputs[i];
            if (input.dataset && typeof input.dataset.name === 'string' && paramPlaceholder.test(input.dataset.name)) {
              task.inputs[i] = { task: producer };
            }
          }
        }
      }
      droppedParams.add(prefixedParam);
      if (prefixedVersionParam) droppedParams.add(prefixedVersionParam);
    } else {
      const ds = datasetMap.get(edge.from.dataset)!;
      datasetDefaults.set(prefixedParam, ds.name);
      if (prefixedVersionParam) datasetDefaults.set(prefixedVersionParam, ds.version);
    }
  }

  // ------------------------------------------------------------------------------------------------
  // Phase C: merge everything into one document + composite recipe.
  // ------------------------------------------------------------------------------------------------
  const mergedTasks: RawTask[] = [];
  const mergedGroups: RawGroup[] = [];
  const mergedResources: Record<string, unknown> = {};
  const mergedDefaults: Record<string, unknown> = {};
  const mergedParams: TemplateParam[] = [];
  type CompositePorts = NonNullable<RecipeMetadata['ports']>;
  const compositeInputs: CompositePorts['inputs'] = [];
  const compositeOutputs: CompositePorts['outputs'] = [];
  const mergedViews: Record<string, ('tensorboard' | 'mlflow')[]> = {};
  const prerequisites: RecipeMetadata['prerequisites'] = [];
  const sources = new Set<string>();
  const artifacts = new Set<string>();
  const imageContracts = new Set<string>();
  let mlflow = false;
  let execT = '0s';
  let queueT = '0s';
  let startT = '0s';
  const readinessRank: RecipeMetadata['readiness'][] = ['cpu-validated', 'image-required', 'prerequisites-required'];
  let readiness: RecipeMetadata['readiness'] = 'cpu-validated';
  const verificationRank: RecipeMetadata['verification'][] = [
    'local-docker',
    'source-verified-network-unverified',
    'source-verified-gpu-unverified',
  ];
  let verification: RecipeMetadata['verification'] = 'local-docker';

  const order = topoOrder.length === graph.nodes.length ? topoOrder : graph.nodes.map((n) => n.id);

  for (const nodeId of order) {
    const node = nodeMap.get(nodeId)!;
    const template = templateMap.get(node.templateId)!;
    const recipe = template.recipe!;
    const slug = slugify(node.title);
    const paramSlug = paramPrefixOf(slug);
    const doc = prefixed.get(nodeId)!;

    // Resources: merge by original name, dedupe identical defs, prefix conflicts and rewrite refs.
    for (const [name, def] of Object.entries(doc.workflow.resources ?? {})) {
      const existing = mergedResources[name];
      if (existing === undefined) {
        mergedResources[name] = def;
      } else if (JSON.stringify(existing) !== JSON.stringify(def)) {
        const renamed = `${slug}-${name}`;
        mergedResources[renamed] = def;
        for (const task of allTasks(doc)) if (task.resource === name) task.resource = renamed;
      }
    }

    mergedTasks.push(...(doc.workflow.tasks ?? []));
    if (doc.workflow.groups) mergedGroups.push(...doc.workflow.groups);

    // default-values: carry over everything except params dropped by node→node edges, then layer the
    // inspector's per-node param overrides (keyed by unprefixed param name) so edited values reach the
    // run. Pinned dataset defaults are applied last so a dataset binding still wins over any override.
    for (const [key, value] of Object.entries(doc['default-values'] ?? {})) {
      if (!droppedParams.has(key)) mergedDefaults[key] = value;
    }
    for (const [name, value] of Object.entries(node.params ?? {})) {
      const prefixedName = `${paramSlug}_${name}`;
      if (!droppedParams.has(prefixedName)) mergedDefaults[prefixedName] = value;
    }
    for (const [key, value] of datasetDefaults) mergedDefaults[key] = value;

    // Params: prefix, relabel, drop bound ones, apply the node override, then the pinned dataset default.
    for (const param of template.params ?? []) {
      const prefixedName = `${paramSlug}_${param.name}`;
      if (droppedParams.has(prefixedName)) continue;
      const override = node.params?.[param.name];
      const pinned = datasetDefaults.get(prefixedName);
      mergedParams.push({
        ...param,
        name: prefixedName,
        label: `${node.title} › ${param.label ?? param.name}`,
        ...(param.versionParam ? { versionParam: `${paramSlug}_${param.versionParam}` } : {}),
        ...(override !== undefined ? { default: override } : {}),
        ...(pinned !== undefined ? { default: String(pinned) } : {}),
      });
    }

    // Composite ports: unbound dataset inputs in, every published output out.
    for (const input of recipe.ports?.inputs ?? []) {
      const key = `${nodeId}/${input.param}`;
      if (boundBy.has(key)) continue;
      compositeInputs.push({
        param: `${paramSlug}_${input.param}`,
        kind: input.kind,
        label: `${node.title} › ${input.label}`,
        ...(input.versionParam ? { versionParam: `${paramSlug}_${input.versionParam}` } : {}),
      });
    }
    // Each node's outputs are namespaced under its (unique) slug, so no cross-node dedupe is needed and
    // the composite port name matches the run-scoped dataset name minus `-{{workflow_id}}` — the same
    // reconstruction `outputKindTag` (server/workflow/artifacts.ts) does when tagging the published kind.
    for (const output of recipe.ports?.outputs ?? []) {
      compositeOutputs.push({ name: namespacedOutput(slug, output.name), kind: output.kind, label: `${node.title} › ${output.label}` });
    }

    // Views: key by the prefixed task name.
    for (const [taskName, modes] of Object.entries(recipe.views ?? {})) mergedViews[`${slug}-${taskName}`] = modes;

    // Scalar merges.
    if (doc.workflow.mlflow) mlflow = true;
    execT = maxDuration(execT, doc.workflow.timeout?.exec_timeout);
    queueT = maxDuration(queueT, doc.workflow.timeout?.queue_timeout);
    startT = maxDuration(startT, doc.workflow.timeout?.start_timeout);
    if (readinessRank.indexOf(recipe.readiness) > readinessRank.indexOf(readiness)) readiness = recipe.readiness;
    if (verificationRank.indexOf(recipe.verification) > verificationRank.indexOf(verification)) verification = recipe.verification;
    prerequisites.push(...recipe.prerequisites);
    for (const s of recipe.sources) sources.add(s);
    for (const a of recipe.artifacts) artifacts.add(a);
    if (recipe.imageContract) imageContracts.add(recipe.imageContract);
  }

  // Guard: a group member depending on another member of the same group (schema forbids this).
  for (const group of mergedGroups) {
    const members = new Set(group.tasks.map((t) => t.name));
    const chained = group.tasks.some((t) => (t.inputs ?? []).some((i) => typeof i.task === 'string' && members.has(i.task)));
    if (chained) errors.push({ code: 'group_task_chained', message: `그룹 "${group.name}" 내부 작업 간 의존성은 지원되지 않습니다.` });
  }

  if (errors.length) return { yaml: '', params: [], recipe: emptyRecipe(), errors };

  const compositeRecipe: RecipeMetadata = {
    revision: 'composed',
    readiness,
    verification,
    prerequisites,
    sources: [...sources],
    artifacts: [...artifacts],
    imageContract: [...imageContracts].join('; '),
    ports: { inputs: compositeInputs, outputs: compositeOutputs },
    views: mergedViews,
  };

  const name = (slugify(graph.nodes[0]?.title ?? 'composed') || 'composed').slice(0, 30).replace(/-+$/g, '');
  const finalDoc: RawDoc = {
    workflow: {
      name,
      description: `Composed pipeline: ${graph.nodes.map((n) => n.title).join(' → ')}`,
      mlflow,
      timeout: {
        exec_timeout: execT === '0s' ? '12h' : execT,
        queue_timeout: queueT === '0s' ? '6h' : queueT,
        start_timeout: startT === '0s' ? '10m' : startT,
      },
      resources: mergedResources,
      tasks: mergedTasks,
      ...(mergedGroups.length ? { groups: mergedGroups } : {}),
    },
    'default-values': mergedDefaults,
    ui: { recipe: compositeRecipe },
  };

  return { yaml: YAML.stringify(finalDoc, { lineWidth: 0 }), params: mergedParams, recipe: compositeRecipe, errors: [] };
}
