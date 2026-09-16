/**
 * Workflow controller: advances the task DAG of every non-terminal workflow by
 * reading Kubernetes Job/Pod state and launching tasks whose inputs succeeded.
 *
 * The reconcile function is pure with respect to its `deps` so it is unit
 * tested with fakes; `startController()` wires the real Kubernetes client and
 * repository and runs the loop under a DynamoDB lease so only one replica acts.
 */
import { randomBytes } from 'node:crypto';
import { GetParameterCommand } from '@aws-sdk/client-ssm';
import { ssm } from '../aws/clients';
import { config, fsxPathToS3 } from '../config';
import { badRequest, notFound } from '../errors';
import * as k8sRes from '../k8s/resources';
import type { Job, Pod } from '../k8s/resources';
import { workloadForJob, workloadState } from '../k8s/kueue';
import { notify } from '../notify';
import { getRepo, type Repo } from '../store/repo';
import { TERMINAL_TASK, TERMINAL_WF, type Task, type TaskPhase, type Workflow, type WorkflowEvent } from '../store/types';
import { compileTask, LABEL_WF, mlflowUriFromConfig, queueForNamespace, type CompileContext } from './compile';
import { durationToSeconds, type TaskSpec, type WorkflowSpec } from './schema';
import { parseWorkflowYaml } from './template';

export interface K8sPort {
  getJob(ns: string, name: string): Promise<Job | null>;
  listPods(ns: string, labelSelector: string): Promise<Pod[]>;
  createJob(ns: string, job: unknown): Promise<unknown>;
  deleteJob(ns: string, name: string): Promise<void>;
  upsertConfigMap(ns: string, name: string, data: Record<string, string>, labels: Record<string, string>): Promise<void>;
  upsertSecret(ns: string, name: string, data: Record<string, string>, labels: Record<string, string>): Promise<void>;
  deleteByLabel(ns: string, kind: 'configmaps' | 'secrets', selector: string): Promise<void>;
  ensureNamespace(ns: string): Promise<void>;
  ensureFsxPvc(ns: string): Promise<void>;
  queueState(ns: string, jobName: string): Promise<'admitted' | 'pending' | 'evicted' | 'finished' | 'unknown'>;
}

export interface ControllerDeps {
  repo: Repo;
  k8s: K8sPort;
  now: () => Date;
  notify: (subject: string, message: string) => Promise<void>;
  resolveCredential: (ref: string) => Promise<string>;
  mlflowTrackingUri?: string;
  dataBucket?: string;
}

export const realK8s: K8sPort = {
  getJob: k8sRes.getJob,
  listPods: (ns, sel) => k8sRes.listPods(ns, sel),
  createJob: k8sRes.createJob,
  deleteJob: k8sRes.deleteJob,
  upsertConfigMap: k8sRes.upsertConfigMap,
  upsertSecret: k8sRes.upsertSecret,
  deleteByLabel: (ns, kind, sel) => k8sRes.deleteByLabel(ns, kind, sel),
  ensureNamespace: k8sRes.ensureNamespace,
  ensureFsxPvc: k8sRes.ensureFsxPvc,
  queueState: async (ns, job) => workloadState(await workloadForJob(ns, job)),
};

export async function resolveCredentialFromSsm(ref: string): Promise<string> {
  if (ref.startsWith('/')) {
    const out = await ssm().send(new GetParameterCommand({ Name: ref, WithDecryption: true }));
    if (out.Parameter?.Value === undefined) throw new Error(`SSM parameter ${ref} has no value`);
    return out.Parameter.Value;
  }
  return ref; // literal (discouraged; templates should use SSM paths)
}

export function realDeps(): ControllerDeps {
  return {
    repo: getRepo(),
    k8s: realK8s,
    now: () => new Date(),
    notify,
    resolveCredential: resolveCredentialFromSsm,
    mlflowTrackingUri: mlflowUriFromConfig(),
    dataBucket: config().eks?.dataBucket,
  };
}

export const newWorkflowId = () => randomBytes(4).toString('hex');

// ---------------------------------------------------------------------------
// Submission
// ---------------------------------------------------------------------------

export interface SubmitInput {
  yaml: string;
  overrides?: Record<string, string>;
  owner: string;
  templateId?: string;
  namespace?: string;
}

export async function submitWorkflow(input: SubmitInput, deps: ControllerDeps = realDeps()): Promise<Workflow> {
  const parsed = parseWorkflowYaml(input.yaml, input.overrides ?? {});
  const spec = parsed.spec;
  const namespace = input.namespace ?? spec.workflow.namespace ?? config().defaultNamespace;
  spec.workflow.namespace = namespace;
  await deps.k8s.ensureNamespace(namespace);
  await deps.k8s.ensureFsxPvc(namespace);

  // Resolve dataset inputs up front so a missing dataset fails at submit time.
  for (const t of spec.workflow.tasks) {
    for (const i of t.inputs) {
      if ('dataset' in i) await resolveDatasetPath(deps.repo, i.dataset.name, i.dataset.version);
    }
  }

  const now = deps.now().toISOString();
  const id = newWorkflowId();
  const wf: Workflow = {
    id,
    name: spec.workflow.name,
    namespace,
    owner: input.owner,
    status: 'PENDING',
    spec,
    specYaml: parsed.yaml,
    vars: parsed.vars,
    templateId: input.templateId,
    createdAt: now,
    updatedAt: now,
    taskCount: spec.workflow.tasks.length,
    succeededCount: 0,
    failedCount: 0,
    labels: spec.workflow.labels,
  };
  await deps.repo.putWorkflow(wf);
  for (const t of spec.workflow.tasks) {
    await deps.repo.putTask({ workflowId: id, name: t.name, phase: 'WAITING', attempts: 0, replicas: t.parallelism, updatedAt: now });
  }
  await event(deps, id, 'info', 'user', 'Submitted', `${input.owner} submitted workflow ${spec.workflow.name} (${spec.workflow.tasks.length} tasks) to namespace ${namespace}`);
  // First reconcile launches root tasks immediately so the UI shows progress without waiting for the loop.
  await reconcileWorkflow(wf, deps).catch((e) => event(deps, id, 'error', 'controller', 'ReconcileError', String(e)));
  return (await deps.repo.getWorkflow(id))!;
}

export async function cancelWorkflow(id: string, actor: string, deps: ControllerDeps = realDeps()): Promise<Workflow> {
  const wf = await deps.repo.getWorkflow(id);
  if (!wf) throw notFound(`workflow ${id}`);
  if (TERMINAL_WF.has(wf.status)) throw badRequest(`workflow is already ${wf.status}`);
  const tasks = await deps.repo.listTasks(id);
  const now = deps.now().toISOString();
  for (const t of tasks) {
    if (TERMINAL_TASK.has(t.phase)) continue;
    if (t.jobName) await deps.k8s.deleteJob(wf.namespace, t.jobName).catch(() => undefined);
    await deps.repo.putTask({ ...t, phase: 'CANCELLED', finishedAt: now, updatedAt: now, message: `cancelled by ${actor}` });
  }
  const updated: Workflow = { ...wf, status: 'CANCELLED', finishedAt: now, updatedAt: now, message: `cancelled by ${actor}` };
  await deps.repo.putWorkflow(updated);
  await event(deps, id, 'warning', 'user', 'Cancelled', `${actor} cancelled the workflow`);
  return updated;
}

export async function retryWorkflow(id: string, actor: string, deps: ControllerDeps = realDeps()): Promise<Workflow> {
  const wf = await deps.repo.getWorkflow(id);
  if (!wf) throw notFound(`workflow ${id}`);
  return submitWorkflow({ yaml: wf.specYaml, owner: actor, templateId: wf.templateId, namespace: wf.namespace }, deps);
}

export async function deleteWorkflow(id: string, deps: ControllerDeps = realDeps()): Promise<void> {
  const wf = await deps.repo.getWorkflow(id);
  if (!wf) return;
  if (!TERMINAL_WF.has(wf.status)) throw badRequest('cancel the workflow before deleting it');
  const tasks = await deps.repo.listTasks(id);
  for (const t of tasks) if (t.jobName) await deps.k8s.deleteJob(wf.namespace, t.jobName).catch(() => undefined);
  await deps.k8s.deleteByLabel(wf.namespace, 'configmaps', `${LABEL_WF}=${id}`).catch(() => undefined);
  await deps.k8s.deleteByLabel(wf.namespace, 'secrets', `${LABEL_WF}=${id}`).catch(() => undefined);
  await deps.repo.deleteWorkflow(id);
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

export async function resolveDatasetPath(repo: Repo, name: string, version: 'latest' | number): Promise<string> {
  const ds = await repo.getDataset(name);
  if (!ds) throw badRequest(`dataset ${name} does not exist`);
  const v = version === 'latest' ? ds.latestVersion : version;
  const ver = await repo.getVersion(name, v);
  if (!ver) throw badRequest(`dataset ${name} has no version ${v}`);
  if (ver.fsxPath) return ver.fsxPath;
  const m = /^s3:\/\/[^/]+\/(datasets|checkpoints)\/(.*)$/.exec(ver.uri);
  if (m) return `/fsx/${m[1]}/${m[2].replace(/\/$/, '')}`;
  throw badRequest(`dataset ${name} v${v} is not reachable from FSx (${ver.uri})`);
}

interface Derived {
  phase: TaskPhase;
  message?: string;
  startedAt?: string;
}

/** Translate Job + Pods (+ Kueue) into a task phase. */
export function deriveTaskPhase(job: Job | null, pods: Pod[], queue: 'admitted' | 'pending' | 'evicted' | 'finished' | 'unknown', replicas: number): Derived {
  if (!job) return { phase: 'FAILED', message: 'Kubernetes Job not found (deleted outside the dashboard?)' };
  const st = job.status ?? {};
  const completions = job.spec.completions ?? 1;
  const failedCond = st.conditions?.find((c) => c.type === 'Failed' && c.status === 'True');
  const completeCond = st.conditions?.find((c) => (c.type === 'Complete' || c.type === 'SuccessCriteriaMet') && c.status === 'True');
  if (completeCond || (st.succeeded ?? 0) >= completions) return { phase: 'SUCCEEDED', startedAt: st.startTime };
  if (failedCond) {
    const lastPod = pods.find((p) => p.status?.phase === 'Failed');
    const cs = lastPod?.status?.containerStatuses?.[0]?.state?.terminated;
    const detail = cs ? ` (exit ${cs.exitCode}${cs.reason ? ` ${cs.reason}` : ''})` : '';
    return { phase: 'FAILED', message: `${failedCond.reason ?? 'Failed'}: ${failedCond.message ?? ''}${detail}`.trim(), startedAt: st.startTime };
  }
  if (pods.some((p) => p.status?.phase === 'Running')) return { phase: 'RUNNING', startedAt: st.startTime ?? pods.find((p) => p.status?.startTime)?.status?.startTime };
  if (pods.length) {
    const pend = pods.find((p) => p.status?.phase === 'Pending');
    const sched = pend?.status?.conditions?.find((c) => c.type === 'PodScheduled' && c.status === 'False');
    const waiting = pend?.status?.containerStatuses?.[0]?.state?.waiting;
    const msg = sched?.message ?? (waiting ? `${waiting.reason ?? ''} ${waiting.message ?? ''}`.trim() : undefined);
    return { phase: 'PENDING', message: msg ? msg.slice(0, 300) : undefined };
  }
  if (job.spec.suspend || queue === 'pending' || queue === 'evicted') return { phase: 'QUEUED', message: queue === 'evicted' ? 'evicted by Kueue (preempted), waiting for re-admission' : 'waiting for Kueue admission (quota)' };
  if ((st.failed ?? 0) > 0 && (st.active ?? 0) === 0 && (job.spec.backoffLimit ?? 0) > 0) return { phase: 'PENDING', message: `retrying (${st.failed}/${(job.spec.backoffLimit ?? 0) + 1} attempts)` };
  return { phase: 'PENDING', message: replicas > 1 ? 'creating pods' : 'creating pod' };
}

async function event(deps: ControllerDeps, workflowId: string, type: WorkflowEvent['type'], source: WorkflowEvent['source'], reason: string, message: string, task?: string) {
  await deps.repo.appendEvent({ workflowId, ts: deps.now().toISOString(), type, source, reason, message, task });
}

async function launchTask(wf: Workflow, task: TaskSpec, tasks: Task[], deps: ControllerDeps): Promise<Task> {
  const spec: WorkflowSpec = wf.spec;
  const datasetPaths: Record<string, string> = {};
  for (const i of task.inputs) if ('dataset' in i) datasetPaths[i.dataset.name] = await resolveDatasetPath(deps.repo, i.dataset.name, i.dataset.version);
  const credentialValues: Record<string, Record<string, string>> = {};
  for (const [cred, mapping] of Object.entries(task.credentials)) {
    credentialValues[cred] = {};
    for (const [envName, ref] of Object.entries(mapping)) credentialValues[cred][envName] = await deps.resolveCredential(ref);
  }
  const ctx: CompileContext = {
    workflowId: wf.id,
    owner: wf.owner,
    namespace: wf.namespace,
    queue: queueForNamespace(wf.namespace, spec.workflow.queue),
    priority: spec.workflow.priority,
    datasetPaths,
    credentialValues,
    mlflowTrackingUri: spec.workflow.mlflow ? deps.mlflowTrackingUri : undefined,
  };
  const compiled = compileTask(spec, task, ctx);
  const labels = { [LABEL_WF]: wf.id, 'pai.aws/task': task.name };
  if (compiled.configMap) await deps.k8s.upsertConfigMap(wf.namespace, compiled.configMap.name, compiled.configMap.data, labels);
  if (compiled.secret) await deps.k8s.upsertSecret(wf.namespace, compiled.secret.name, compiled.secret.data, labels);
  await deps.k8s.createJob(wf.namespace, compiled.job);
  const now = deps.now().toISOString();
  const prev = tasks.find((t) => t.name === task.name)!;
  const t: Task = { ...prev, phase: ctx.queue ? 'QUEUED' : 'PENDING', jobName: compiled.jobName, attempts: prev.attempts + 1, queuedAt: now, updatedAt: now, outputPath: compiled.outputPath, message: undefined };
  await deps.repo.putTask(t);
  await event(deps, wf.id, 'info', 'controller', 'TaskLaunched', `created Job ${compiled.jobName}${ctx.queue ? ` in queue ${ctx.queue}` : ''}`, task.name);
  return t;
}

async function publishOutputs(wf: Workflow, taskSpec: TaskSpec, task: Task, deps: ControllerDeps): Promise<Task> {
  const published: { dataset: string; version: number }[] = [];
  for (const o of taskSpec.outputs) {
    if (!('dataset' in o)) continue;
    const fsxPath = o.dataset.path.replace(/\{\{\s*output\s*\}\}/g, task.outputPath ?? '').replace(/\/$/, '');
    const uri = deps.dataBucket ? fsxPathToS3(fsxPath, deps.dataBucket) : undefined;
    const now = deps.now().toISOString();
    let ds = await deps.repo.getDataset(o.dataset.name);
    if (!ds) {
      ds = { name: o.dataset.name, owner: wf.owner, tags: [], latestVersion: 0, createdAt: now, updatedAt: now, description: `Produced by workflow ${wf.name}` };
    }
    const version = ds.latestVersion + 1;
    await deps.repo.putVersion({
      dataset: ds.name,
      version,
      uri: uri ?? `fsx://${fsxPath}`,
      fsxPath,
      tags: [],
      producedBy: { workflowId: wf.id, task: task.name },
      createdAt: now,
      createdBy: wf.owner,
      note: o.dataset.note,
    });
    await deps.repo.putDataset({ ...ds, latestVersion: version, updatedAt: now });
    published.push({ dataset: ds.name, version });
    await event(deps, wf.id, 'info', 'controller', 'DatasetPublished', `published ${ds.name} v${version} from ${fsxPath}${uri ? ` (${uri})` : ''}`, task.name);
  }
  const t = { ...task, publishedVersions: published };
  await deps.repo.putTask(t);
  return t;
}

/** One reconcile pass for one workflow. Returns the updated workflow. */
export async function reconcileWorkflow(wfIn: Workflow, deps: ControllerDeps): Promise<Workflow> {
  let wf = wfIn;
  if (TERMINAL_WF.has(wf.status)) return wf;
  const spec = wf.spec;
  const specByName = new Map(spec.workflow.tasks.map((t) => [t.name, t]));
  let tasks = await deps.repo.listTasks(wf.id);
  const byName = () => new Map(tasks.map((t) => [t.name, t]));
  const nowIso = deps.now().toISOString();
  const nowMs = deps.now().getTime();

  // 1. Refresh state of launched, non-terminal tasks.
  for (const t of tasks) {
    if (!t.jobName || TERMINAL_TASK.has(t.phase)) continue;
    const job = await deps.k8s.getJob(wf.namespace, t.jobName);
    const pods = job ? await deps.k8s.listPods(wf.namespace, `job-name=${t.jobName}`) : [];
    const queue = job && !pods.length ? await deps.k8s.queueState(wf.namespace, t.jobName) : 'unknown';
    const d = deriveTaskPhase(job, pods, queue, t.replicas);
    if (d.phase !== t.phase || d.message !== t.message) {
      const updated: Task = { ...t, phase: d.phase, message: d.message, updatedAt: nowIso, startedAt: t.startedAt ?? d.startedAt ?? (d.phase === 'RUNNING' ? nowIso : undefined) };
      if (TERMINAL_TASK.has(d.phase)) updated.finishedAt = nowIso;
      await deps.repo.putTask(updated);
      if (d.phase !== t.phase) await event(deps, wf.id, d.phase === 'FAILED' ? 'error' : 'info', 'kubernetes', `Task${cap(d.phase)}`, d.message ?? `${t.jobName} is ${d.phase.toLowerCase()}`, t.name);
      tasks = tasks.map((x) => (x.name === t.name ? updated : x));
      if (d.phase === 'SUCCEEDED') {
        const pubd = await publishOutputs(wf, specByName.get(t.name)!, updated, deps);
        tasks = tasks.map((x) => (x.name === t.name ? pubd : x));
      }
    } else if (t.phase === 'QUEUED' && t.queuedAt) {
      // 2. Queue timeout
      const limit = durationToSeconds(spec.workflow.timeout.queue_timeout) * 1000;
      if (nowMs - new Date(t.queuedAt).getTime() > limit) {
        await deps.k8s.deleteJob(wf.namespace, t.jobName).catch(() => undefined);
        const updated: Task = { ...t, phase: 'FAILED', message: `queue timeout (${spec.workflow.timeout.queue_timeout}) exceeded waiting for admission`, finishedAt: nowIso, updatedAt: nowIso };
        await deps.repo.putTask(updated);
        await event(deps, wf.id, 'error', 'controller', 'QueueTimeout', updated.message!, t.name);
        tasks = tasks.map((x) => (x.name === t.name ? updated : x));
      }
    }
  }

  // 3. Handle failures per on_failure policy; skip tasks whose deps can never succeed.
  const anyFailed = tasks.some((t) => t.phase === 'FAILED');
  if (anyFailed && spec.workflow.on_failure === 'cancel_pending') {
    for (const t of tasks) {
      if (TERMINAL_TASK.has(t.phase)) continue;
      if (t.jobName) await deps.k8s.deleteJob(wf.namespace, t.jobName).catch(() => undefined);
      const updated: Task = { ...t, phase: t.jobName ? 'CANCELLED' : 'SKIPPED', message: 'cancelled because another task failed', finishedAt: nowIso, updatedAt: nowIso };
      await deps.repo.putTask(updated);
      tasks = tasks.map((x) => (x.name === t.name ? updated : x));
    }
  } else {
    for (const t of tasks) {
      if (t.phase !== 'WAITING') continue;
      const deps_ = specByName.get(t.name)!.inputs.flatMap((i) => ('task' in i ? [i.task] : []));
      const m = byName();
      if (deps_.some((d) => ['FAILED', 'SKIPPED', 'CANCELLED'].includes(m.get(d)?.phase ?? ''))) {
        const updated: Task = { ...t, phase: 'SKIPPED', message: 'skipped because an upstream task did not succeed', finishedAt: nowIso, updatedAt: nowIso };
        await deps.repo.putTask(updated);
        tasks = tasks.map((x) => (x.name === t.name ? updated : x));
      }
    }
  }

  // 4. Launch ready tasks.
  for (const t of tasks) {
    if (t.phase !== 'WAITING') continue;
    const ts = specByName.get(t.name)!;
    const m = byName();
    const ready = ts.inputs.every((i) => !('task' in i) || m.get(i.task)?.phase === 'SUCCEEDED');
    if (!ready) continue;
    try {
      const launched = await launchTask(wf, ts, tasks, deps);
      tasks = tasks.map((x) => (x.name === t.name ? launched : x));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const updated: Task = { ...t, phase: 'FAILED', message: `launch failed: ${msg}`.slice(0, 500), finishedAt: nowIso, updatedAt: nowIso };
      await deps.repo.putTask(updated);
      await event(deps, wf.id, 'error', 'controller', 'LaunchFailed', msg, t.name);
      tasks = tasks.map((x) => (x.name === t.name ? updated : x));
    }
  }

  // 5. Workflow status roll-up.
  const counts = { succeeded: tasks.filter((t) => t.phase === 'SUCCEEDED').length, failed: tasks.filter((t) => t.phase === 'FAILED').length };
  const allTerminal = tasks.every((t) => TERMINAL_TASK.has(t.phase));
  let status = wf.status;
  let message = wf.message;
  if (allTerminal) {
    if (tasks.every((t) => t.phase === 'SUCCEEDED')) status = 'SUCCEEDED';
    else {
      status = 'FAILED';
      const f = tasks.find((t) => t.phase === 'FAILED');
      message = f ? `task ${f.name}: ${f.message ?? 'failed'}` : 'some tasks did not succeed';
    }
  } else if (tasks.some((t) => t.phase !== 'WAITING')) {
    status = 'RUNNING';
  }
  const startedAt = wf.startedAt ?? (status !== 'PENDING' ? nowIso : undefined);
  const changed = status !== wf.status || counts.succeeded !== wf.succeededCount || counts.failed !== wf.failedCount;
  wf = { ...wf, status, message, startedAt, updatedAt: nowIso, succeededCount: counts.succeeded, failedCount: counts.failed, finishedAt: TERMINAL_WF.has(status) ? nowIso : undefined };
  if (changed || wf.updatedAt !== wfIn.updatedAt) await deps.repo.putWorkflow(wf);
  if (status !== wfIn.status && TERMINAL_WF.has(status)) {
    await event(deps, wf.id, status === 'SUCCEEDED' ? 'info' : 'error', 'controller', `Workflow${cap(status)}`, message ?? `all ${tasks.length} tasks succeeded`);
    const settings = await deps.repo.getSettings();
    if (settings.notifyOn.includes(status as 'SUCCEEDED' | 'FAILED' | 'CANCELLED')) {
      await deps.notify(`[Physical AI] workflow ${wf.name} ${status}`, `Workflow ${wf.name} (${wf.id}) owned by ${wf.owner} finished with status ${status}.\n${message ?? ''}\nTasks: ${counts.succeeded}/${tasks.length} succeeded.`);
    }
  }
  return wf;
}

const cap = (s: string) => s.charAt(0) + s.slice(1).toLowerCase();

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------

export interface ControllerStatus { running: boolean; holder: string; lastTick?: string; lastError?: string; ticks: number; leased: boolean }
const status: ControllerStatus = { running: false, holder: `${process.pid}-${randomBytes(2).toString('hex')}`, ticks: 0, leased: false };
export const controllerStatus = () => status;

export async function reconcileAll(deps: ControllerDeps = realDeps()): Promise<number> {
  const wfs = (await deps.repo.listWorkflows({ limit: 200 })).filter((w) => !TERMINAL_WF.has(w.status));
  for (const wf of wfs) {
    try {
      await reconcileWorkflow(wf, deps);
    } catch (e) {
      console.error(`reconcile ${wf.id} failed`, e);
      await event(deps, wf.id, 'error', 'controller', 'ReconcileError', e instanceof Error ? e.message : String(e)).catch(() => undefined);
    }
  }
  return wfs.length;
}

let timer: NodeJS.Timeout | undefined;
export function startController(intervalMs = 10_000): void {
  if (timer) return;
  status.running = true;
  const tick = async () => {
    try {
      const deps = realDeps();
      status.leased = await deps.repo.acquireLease('CONTROLLER', status.holder, 30);
      if (status.leased) {
        await reconcileAll(deps);
        status.ticks++;
        status.lastTick = new Date().toISOString();
        status.lastError = undefined;
      }
    } catch (e) {
      status.lastError = e instanceof Error ? e.message : String(e);
      console.error('controller tick failed', e);
    }
  };
  timer = setInterval(tick, intervalMs);
  void tick();
}
export function stopController(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
  status.running = false;
}
