import { createHash, randomBytes } from 'node:crypto';
import { config } from '../config';
import { badRequest, notFound } from '../errors';
import type { Repo } from '../store/repo';
import { TERMINAL_WF, type Workflow, type DatasetSnapshot } from '../store/types';
import type { ControllerDeps } from './ports';
import { parseWorkflowYaml } from './template';
import { assertSafePath } from './validation';
import { reconcileWorkflowInternal } from './execution';
import { withRunLease } from './lease';
import { deliverOutbox } from './outbox';
import { checkpointSources, checkpointURL, type RecoveryTask, type RecoveryWorkflow, type RetryCheckpointContext } from './checkpoints';
import { applyTrustedImagePins, imagePinBindings, validatePreflightReview } from './image-pins';
import { backendId, DEFAULT_BACKEND } from '../backends/registry';
import { runOnBackend } from '../backends/context';
import { assertExecutionPin } from './execution-profile-policy';
export const CREDENTIAL_PREFIXES = ['/groot/', '/physical-ai/', '/pai/'] as const;
export function assertCredentialRef(ref: string): void {
  if (!CREDENTIAL_PREFIXES.some(p => ref.startsWith(p)) || ref.includes('..')) throw badRequest(`credential ref ${ref} must be an SSM parameter path under ${CREDENTIAL_PREFIXES.join(', ')}`);
}
export const newWorkflowId = () => randomBytes(8).toString('hex');
export interface SubmitInput {
  yaml: string;
  overrides?: Record<string, string>;
  owner: string;
  templateId?: string;
  templateVersion?: number;
  templateContentHash?: string;
  templateModified?: boolean;
  namespace?: string;
  queue?: string;
  projectId?: string;
  ownerSubject?: string;
  backendId?: string;
  backendConfigHash?: string;
  idempotencyKey?: string;
  deferLaunch?: boolean;
  /** Supplied only by the trusted API preflight binding, never parsed from YAML. */
  imagePins?: Workflow['imagePins'];
  executionProfilePins?: Workflow['executionProfilePins'];
  preflightReviewedBy?: string;
  preflightReviewedAt?: string;
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ':' + stable(v)).join(',')}}`;
  return JSON.stringify(value);
}
export async function snapshotDataset(repo: Repo, name: string, version: 'latest' | number): Promise<DatasetSnapshot> {
  const ds = await repo.getDataset(name);
  if (!ds) throw badRequest(`dataset ${name} does not exist`);
  const n = version === 'latest' ? ds.latestVersion : version;
  const v = await repo.getVersion(name, n);
  if (!v) throw badRequest(`dataset ${name} has no version ${n}`);
  if (v.state === 'PENDING') throw badRequest(`dataset ${name} v${n} is not READY`);
  let path = v.projectId && v.manifestHash
    ? `/fsx/datasets/projects/${v.projectId}/${name}/v${n}`
    : v.fsxPath;
  if (!path && config().eks?.dataBucket && v.uri.startsWith(`s3://${config().eks!.dataBucket}/`)) {
    const m = /^s3:\/\/[^/]+\/(datasets|checkpoints)\/(.*)$/.exec(v.uri);
    if (m) path = `/fsx/${m[1]}/${m[2].replace(/\/$/, '')}`;
  }
  if (!path) throw badRequest(`dataset ${name} v${n} is not reachable from FSx (${v.uri})`);
  assertSafePath(path);
  if (!path.startsWith('/fsx/')) throw badRequest('dataset snapshot must be within /fsx');
  return {
    name,
    version: n,
    uri: v.uri,
    fsxPath: path,
    manifestHash: v.manifestHash
  };
}
export async function resolveDatasetPath(repo: Repo, name: string, version: 'latest' | number): Promise<string> {
  return (await snapshotDataset(repo, name, version)).fsxPath;
}
export async function submitWorkflowInternal(input: SubmitInput, deps: ControllerDeps, retrySnapshots?: Workflow['datasetSnapshots'], recovery?: RetryCheckpointContext): Promise<Workflow> {
  if (input.projectId) {
    const project = await deps.repo.kv.get(`PROJECT#${input.projectId}`, 'META');
    if (project) {
      if (input.backendId && backendId(input.backendId) !== backendId(project.backendId as string | undefined)) throw badRequest('Workflow backend must match its immutable project binding');
      input = { ...input, backendId: backendId(project.backendId as string | undefined), backendConfigHash: project.backendConfigHash as string | undefined };
    } else if (input.backendId && input.backendId !== DEFAULT_BACKEND) throw badRequest('Additional backend requires a registered project');
  }
  return runOnBackend(input, () => submitBoundWorkflow(input, deps, retrySnapshots, recovery), deps.repo);
}
async function submitBoundWorkflow(input: SubmitInput, deps: ControllerDeps, retrySnapshots?: Workflow['datasetSnapshots'], recovery?: RetryCheckpointContext): Promise<Workflow> {
  const parsed = parseWorkflowYaml(input.yaml, input.overrides ?? {}),
    spec = parsed.spec;
  const imagePins = applyTrustedImagePins(spec, input.imagePins);
  validatePreflightReview(input.preflightReviewedBy, input.preflightReviewedAt);
  if (input.projectId) {
    if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(input.projectId)) throw badRequest('invalid projectId');
    if (!input.namespace || !input.queue || ['none', 'auto'].includes(input.queue)) throw badRequest('project submission requires server namespace and an explicit admission queue');
    if (spec.workflow.tasks.some(task => task.volumes.length)) throw badRequest('user volumes are not permitted for project submissions');
    spec.workflow.namespace = input.namespace;
    spec.workflow.queue = input.queue;
  } else {
    spec.workflow.namespace = input.namespace ?? spec.workflow.namespace ?? config().defaultNamespace;
    if (input.queue) spec.workflow.queue = input.queue;
  }
  const namespace = spec.workflow.namespace!;
  for (const task of spec.workflow.tasks) if (task.executionProfile || input.executionProfilePins?.[task.name]) {
    if (!deps.validateTaskPolicy) throw badRequest('Trusted execution requires a launch-time policy validator');
    try { assertExecutionPin(input.executionProfilePins?.[task.name], task, spec.workflow.resources[task.resource] ?? {}, {
      projectId: input.projectId, namespace, backendId: input.backendId,
    }); } catch { throw badRequest('Trusted execution requires current server-bound administrator approval'); }
  }
  const hash = createHash('sha256').update(stable({
    spec,
    namespace,
    backendId: input.backendId,
    backendConfigHash: input.backendConfigHash,
    templateId: input.templateId,
    templateVersion: input.templateVersion,
    templateContentHash: input.templateContentHash,
    templateModified: input.templateModified,
    imagePins: imagePinBindings(imagePins),
    executionProfilePins: input.executionProfilePins,
    preflightReviewedBy: input.preflightReviewedBy,
    ...(recovery ? { retryOf: recovery.retryOf, checkpointRestoreSources: recovery.sources } : {}),
  })).digest('hex');
  if (input.idempotencyKey && (input.idempotencyKey.length > 256 || !input.idempotencyKey.trim())) throw badRequest('invalid idempotency key');
  const scope = input.idempotencyKey ? createHash('sha256').update(stable([input.projectId ?? namespace, input.ownerSubject ?? input.owner, 'submit', input.idempotencyKey])).digest('hex') : undefined;
  if (scope) {
    const saved = await deps.repo.findSubmission(scope, hash);
    if (saved) return resumeSubmission(saved, input, deps);
  }
  if (spec.workflow.groups?.length && (!deps.k8s.getJobSet || !deps.k8s.createJobSet || !deps.k8s.deleteJobSet || !deps.runtimeCommand && !deps.runtimeImage || !deps.groupRuntime)) throw badRequest('Grouped execution requires JobSet and a verified barrier/attempt-fencing runtime adapter; independent Jobs are unsupported');
  if (spec.workflow.tasks.some(t => t.checkpoint?.length) && !deps.runtimeCommand && !deps.runtimeImage) throw badRequest('checkpoint execution requires a verified workload runtime');
  for (const task of spec.workflow.tasks) for (const [index, checkpoint] of (task.checkpoint ?? []).entries()) {
    try { checkpointURL(checkpoint, index, { workflowId: 'pending', task: task.name, projectId: input.projectId, artifactBucket: deps.artifactBucket ?? process.env.DASHBOARD_ARTIFACT_BUCKET }); }
    catch { throw badRequest('auto checkpoints require a project and configured artifact bucket'); }
  }
  for (const g of spec.workflow.groups ?? []) {
    if (g.ignoreNonleadStatus && g.tasks.some(t => t.exitActions?.RESCHEDULE !== undefined)) throw badRequest('independent nonlead reschedule is unsupported; set ignoreNonleadStatus: false for whole-group retry');
  }
  if (spec.workflow.tasks.some(t => spec.workflow.resources[t.resource]?.topology?.length) && !deps.topologyInventory) throw badRequest('Native OSMO topology requires a registered namespace/queue topology inventory provider');
  const snapshots: NonNullable<Workflow['datasetSnapshots']> = {};
  for (const task of spec.workflow.tasks) {
    for (const [index, i] of task.inputs.entries()) if ('dataset' in i) {
      const snapshot = retrySnapshots?.[task.name]?.[index] ?? (await snapshotDataset(deps.repo, i.dataset.name, i.dataset.version));
      if (backendId(input.backendId) !== DEFAULT_BACKEND && (!snapshot.manifestHash || !snapshot.uri.startsWith('s3://') || !snapshot.fsxPath.startsWith(`/fsx/datasets/projects/${input.projectId}/`))) {
        throw badRequest('Additional backends require immutable S3 manifest inputs and isolated runtime hydration; FSx-only inputs are unsupported');
      }
      if (input.projectId) {
        const dataset = await deps.repo.getDataset(i.dataset.name);
        if (dataset?.projectId !== input.projectId) throw badRequest(`dataset ${i.dataset.name} belongs to another project`);
      }
      snapshots[task.name] ??= {};
      snapshots[task.name][index] = snapshot;
      i.dataset.version = snapshot.version;
    }
    for (const mapping of Object.values(task.credentials)) for (const ref of Object.values(mapping)) assertCredentialRef(ref);
  }
  // Keep grouped normalized task definitions consistent with their pinned flat counterparts.
  for (const group of spec.workflow.groups ?? []) group.tasks = group.tasks.map(t => spec.workflow.tasks.find(x => x.name === t.name)!);
  const now = deps.now().toISOString(),
    id = newWorkflowId();
  for (const task of spec.workflow.tasks) {
    for (const output of task.outputs) {
      if ('dataset' in output) output.dataset.name = output.dataset.name.replace(/\{\{\s*workflow_id\s*\}\}/g, id);
    }
  }
  const wf: RecoveryWorkflow = {
    id,
    name: spec.workflow.name,
    namespace,
    owner: input.owner,
    ownerSubject: input.ownerSubject,
    projectId: input.projectId,
    backendId: input.backendId,
    backendConfigHash: input.backendConfigHash,
    status: 'PENDING',
    spec,
    specYaml: parsed.yaml,
    vars: parsed.vars,
    templateId: input.templateId,
    templateVersion: input.templateVersion,
    templateContentHash: input.templateContentHash,
    templateModified: input.templateModified,
    imagePins,
    executionProfilePins: input.executionProfilePins,
    preflightReviewedBy: input.preflightReviewedBy,
    preflightReviewedAt: input.preflightReviewedAt,
    createdAt: now,
    updatedAt: now,
    taskCount: spec.workflow.tasks.length,
    succeededCount: 0,
    failedCount: 0,
    labels: spec.workflow.labels,
    specHash: hash,
    datasetSnapshots: snapshots,
    ...(recovery ? { retryOf: recovery.retryOf } : {})
  };
  const saved = await deps.repo.createWorkflow(wf, spec.workflow.tasks.map(t => ({
    workflowId: id,
    name: t.name,
    phase: 'WAITING',
    attempts: 0,
    replicas: t.parallelism,
    groupId: t.group,
    ...(t.checkpoint?.length && recovery?.sources[t.name]?.length
      ? { checkpointRestoreSources: recovery.sources[t.name] } : {}),
    updatedAt: now
  })), scope ? {
    scope,
    hash
  } : undefined, [...(deps.dispatchWorkflow ? ['dispatch' as const] : []), ...(deps.enqueueWorkflow ? ['enqueue' as const] : [])]);
  if (saved.id === id) await deps.repo.appendEvent({
    workflowId: id,
    ts: now,
    type: 'info',
    source: 'user',
    reason: 'Submitted',
    message: `${input.owner} submitted ${wf.name}`
  });
  return resumeSubmission(saved, input, deps);
}
async function resumeSubmission(wf: Workflow, input: SubmitInput, deps: ControllerDeps): Promise<Workflow> {
  if (input.deferLaunch || deps.dispatchWorkflow || deps.enqueueWorkflow) {
    await withRunLease(wf.id, deps, guard => deliverOutbox(wf, deps, guard));
  } else {
    await reconcileWorkflowInternal(wf, deps);
  }
  return (await deps.repo.getWorkflow(wf.id))!;
}
export async function retryWorkflowInternal(id: string, actor: string, deps: ControllerDeps, identity?: {
  ownerSubject: string;
}): Promise<Workflow> {
  const wf = await deps.repo.getWorkflow(id);
  if (!wf) throw notFound(`workflow ${id}`);
  if (!TERMINAL_WF.has(wf.status)) throw badRequest('workflow must finish or cancel before retry');
  const oldTasks = await deps.repo.listTasks(wf.id);
  const recovery: RetryCheckpointContext = {
    retryOf: wf.id,
    sources: Object.fromEntries(oldTasks.filter(task =>
      wf.spec.workflow.tasks.find(spec => spec.name === task.name)?.checkpoint?.length
    ).map(task => [task.name, checkpointSources(wf, task as RecoveryTask)])),
  };
  // Persisted numeric versions and paths are reused even if registry latest advances.
  return submitWorkflowInternal({
    yaml: wf.specYaml,
    overrides: wf.vars,
    owner: actor,
    ownerSubject: identity?.ownerSubject ?? (actor === wf.owner ? wf.ownerSubject : undefined),
    projectId: wf.projectId,
    namespace: wf.namespace,
    queue: wf.spec.workflow.queue,
    backendId: wf.backendId,
    backendConfigHash: wf.backendConfigHash,
    templateId: wf.templateId,
    templateVersion: wf.templateVersion,
    templateContentHash: wf.templateContentHash,
    templateModified: wf.templateModified,
    imagePins: wf.imagePins,
    executionProfilePins: wf.executionProfilePins,
    preflightReviewedBy: wf.preflightReviewedBy,
    preflightReviewedAt: wf.preflightReviewedAt,
  }, deps, wf.datasetSnapshots, recovery);
}
