import { planTopology, TopologyError } from './topology/planner';
import { assertPlan, assertWorkloadPlan } from './topology/affinity';
import { observePlacement } from './topology/observe';
import { createHash } from 'node:crypto';
import { badRequest, notFound } from '../errors';
import type { Job } from '../k8s/resources';
import { TERMINAL_TASK, TERMINAL_WF, type Task, type Workflow, type TaskPhase } from '../store/types';
import { compileTask, LABEL_WF, jobNameFor, jobSetNameFor, outputPathFor, queueForNamespace, usesRuntime, type CompileContext } from './compile';
import { compileGroup } from './groups';
import { deriveTaskPhase } from './status';
import { durationToSeconds, type TaskSpec, type GroupSpec } from './schema';
import { exitRanges } from './validation';
import { withRunLease, type LeaseGuard } from './lease';
import { finalizeTask } from './artifacts';
import { deliverOutbox } from './outbox';
import { readTaskRuntimeOutcome } from './runtime-outcome';
import type { ControllerDeps, JobSet } from './ports';
import { checkpointSources, type RecoveryTask } from './checkpoints';
import { runOnBackend, backendConfig, assertBackendReady } from '../backends/context';
import { assertWorkflowBackend } from '../backends/binding';
interface Unit {
  name: string;
  specs: TaskSpec[];
  group?: GroupSpec;
}
const message = (e: unknown) => e instanceof Error ? e.message : String(e);
const cap = (s: string) => s[0] + s.slice(1).toLowerCase();
function units(wf: Workflow): Unit[] {
  return [...(wf.spec.workflow.groups ?? []).map(group => ({
    name: group.name,
    specs: group.tasks,
    group
  })), ...wf.spec.workflow.tasks.filter(t => !t.group).map(t => ({
    name: t.name,
    specs: [t]
  }))];
}
async function event(wf: Workflow, deps: ControllerDeps, reason: string, text: string, task?: string) {
  await deps.repo.appendEvent({
    workflowId: wf.id,
    ts: deps.now().toISOString(),
    type: reason.includes('Failed') ? 'error' : 'info',
    source: 'controller',
    reason,
    message: text,
    task
  });
}
function owned(object: Job | JobSet, wf: Workflow, task: Task): void {
  const labels = object.metadata.labels;
  if (labels?.[LABEL_WF] !== wf.id || labels?.['pai.aws/attempt'] !== undefined && labels['pai.aws/attempt'] !== String(task.attempts) || task.attemptEpoch && labels?.['pai.aws/epoch'] !== task.attemptEpoch || task.jobUid && object.metadata.uid && task.jobUid !== object.metadata.uid) throw new Error(`workload ownership/attempt mismatch for ${task.jobName}`);
}
async function context(wf: Workflow, ts: TaskSpec, task: Task, all: Task[], deps: ControllerDeps): Promise<CompileContext> {
  const datasetPathsByInput: Record<number, string> = {};
  for (const [index, input] of ts.inputs.entries()) if ('dataset' in input) {
    const snap = wf.datasetSnapshots?.[ts.name]?.[index];
    if (!snap) throw new Error('Legacy dataset input has no immutable snapshot; resubmit with a pinned version');
    datasetPathsByInput[index] = snap.fsxPath;
  }
  const credentialValues: Record<string, Record<string, string>> = {};
  for (const [cred, mapping] of Object.entries(ts.credentials)) {
    credentialValues[cred] = {};
    for (const [key, ref] of Object.entries(mapping)) credentialValues[cred][key] = await deps.resolveCredential(ref);
  }
  return {
    workflowId: wf.id,
    executionProfile: wf.executionProfilePins?.[ts.name],
    projectId: wf.projectId,
    backendId: wf.backendId,
    attempt: task.attempts,
    artifactBucket: deps.artifactBucket ?? process.env.DASHBOARD_ARTIFACT_BUCKET,
    checkpointRestore: Boolean(ts.checkpoint?.length && (task as RecoveryTask).checkpointRestoreSources?.length),
    owner: wf.owner,
    namespace: wf.namespace,
    queue: queueForNamespace(wf.namespace, wf.spec.workflow.queue),
    priority: wf.spec.workflow.priority,
    datasetPaths: {},
    datasetPathsByInput,
    credentialValues,
    taskOutputPaths: Object.fromEntries(all.filter(t => t.outputPath).map(t => [t.name, t.outputPath!])),
    runtimeCommand: deps.runtimeCommand,
    runtimeImage: deps.runtimeImage,
    liveImage: deps.liveImage,
    epoch: task.attemptEpoch,
    runtimeEnvironment: deps.runtimeEnvironment?.(wf, ts, task.attemptEpoch!, task.attempts),
    sharedReadOnlyPaths: deps.sharedReadOnlyPaths?.(wf, ts),
    workloadServiceAccount: deps.workloadServiceAccount,
    mlflowTrackingUri: wf.spec.workflow.mlflow ? deps.mlflowTrackingUri : undefined
  };
}
async function launch(wf: Workflow, unit: Unit, ts: Task[], all: Task[], deps: ControllerDeps, guard: LeaseGuard): Promise<Task[]> {
  assertBackendReady();
  await guard.check();
  if (await deps.repo.cancellation(wf.id)) return ts;
  const now = deps.now().toISOString();
  if (ts.every(t => t.phase === 'WAITING' || t.phase === 'RETRY_WAIT')) {
    const attempt = Math.max(...ts.map(t => t.attempts)) + 1;
    const epoch = createHash('sha256').update(`${wf.id}:${unit.name}:${attempt}`).digest('hex').slice(0, 32);
    const name = unit.group ? jobSetNameFor(wf.id, unit.name, attempt) : jobNameFor(wf.id, unit.name, attempt);
    ts = ts.map(t => ({
      ...t,
      ...(unit.specs.find(spec => spec.name === t.name)?.checkpoint?.length
        ? { checkpointRestoreSources: checkpointSources(wf, t as RecoveryTask) } : {}),
      phase: 'LAUNCHING',
      attempts: attempt,
      attemptEpoch: epoch,
      topologyPlan: undefined,
      topologyDiagnostics: undefined,
      runtimeWrapped: usesRuntime(unit.specs.find(spec => spec.name === t.name)!, { projectId: wf.projectId, runtimeImage: deps.runtimeImage }, !!unit.group),
      runtimeFailure: undefined,
      wrapperExitCode: undefined,
      exitCode: undefined,
      jobName: name,
      jobUid: undefined,
      workloadKind: unit.group ? 'JobSet' : 'Job',
      launchIntentAt: now,
      queuedAt: now,
      admittedAt: undefined,
      startedAt: undefined,
      finishedAt: undefined,
      nextRetryAt: undefined,
      cleanupTarget: undefined,
      artifactReceipts: undefined,
      publishedVersions: undefined,
      observedPhase: undefined,
      ignoredByGroupPolicy: undefined,
      outputPath: outputPathFor(wf.id, t.name, attempt, wf.projectId),
      updatedAt: now,
      message: undefined
    }));
    await deps.repo.putTasks(ts, guard.lease); // durable intent precedes EVERY external mutation
  }
  if (unit.specs.some(t => wf.spec.workflow.resources[t.resource]?.topology?.length)) {
    if (!deps.topologyInventory) throw new TopologyError('CONFIG', 'worker has no registered topology inventory provider');
    const inventory = await deps.topologyInventory(wf, guard.signal);
    await guard.check();
    if (!ts[0].topologyPlan) {
      const placement = planTopology({ spec: wf.spec, tasks: unit.specs, inventory, namespace: wf.namespace,
        queue: queueForNamespace(wf.namespace, wf.spec.workflow.queue), workflowId: wf.id,
        epoch: ts[0].attemptEpoch!, now: deps.now() });
      ts = ts.map((t, index) => index === 0 ? { ...t, topologyPlan: placement } : t);
      await deps.repo.putTasks(ts, guard.lease); // immutable plan precedes any workload creation
      await event(wf, deps, 'TopologyPlanned', `placement ${placement.hash}; preferred relaxed: ${placement.relaxed.join('; ') || 'none'}`, ts[0].name);
    }
    assertPlan(ts[0].topologyPlan!, wf.id, wf.namespace, ts[0].attemptEpoch);
    const observed = observePlacement(ts[0].topologyPlan!, inventory, wf.spec, unit.specs, [], deps.now());
    if (observed.issue) throw new TopologyError('PLACEMENT', observed.issue);
  }
  const first = ts[0];
  const existing = unit.group ? await deps.k8s.getJobSet!(wf.namespace, first.jobName!) : await deps.k8s.getJob(wf.namespace, first.jobName!);
  if (existing) {
    owned(existing, wf, first);
    if (first.topologyPlan) assertWorkloadPlan(existing, first.topologyPlan);
  } else {
    await guard.check();
    await deps.k8s.ensureNamespace(wf.namespace);
    await deps.k8s.ensureFsxPvc(wf.namespace);
    const contexts: Record<string, CompileContext> = {};
    for (const spec of unit.specs) contexts[spec.name] = await context(wf, spec, ts.find(t => t.name === spec.name)!, all, deps);
    for (const ctx of Object.values(contexts)) ctx.topologyPlan = first.topologyPlan;
    const ctx = contexts[first.name];
    const group = unit.group ? compileGroup(wf.spec, unit.group, ctx, first.attemptEpoch!, contexts) : undefined;
    const compiled = group?.tasks ?? [compileTask(wf.spec, unit.specs[0], ctx)];
    for (const item of compiled) {
      await guard.check();
      if (item.configMap) await deps.k8s.upsertConfigMap(wf.namespace, item.configMap.name, item.configMap.data, {
        [LABEL_WF]: wf.id
      });
      if (item.secret) {
        if (deps.k8s.ensureAttemptSecret) {
          const job = item.job as unknown as Job;
          const secret = await deps.k8s.ensureAttemptSecret(wf.namespace, item.secret.name, item.secret.data, job.metadata.labels ?? {});
          job.spec.template.metadata ??= { name: '' };
          job.spec.template.metadata.annotations = { ...job.spec.template.metadata.annotations,
            'pai.aws/attempt-secret-name': item.secret.name, 'pai.aws/attempt-secret-uid': secret.uid };
        } else await deps.k8s.upsertSecret(wf.namespace, item.secret.name, item.secret.data, { [LABEL_WF]: wf.id });
      }
    }
    await guard.check();
    if (await deps.repo.cancellation(wf.id)) return ts;
    // All members pass policy before any Job/JobSet is created. Keep this
    // outside the create/adoption catch so a denial cannot be mistaken for a
    // lost Kubernetes create response.
    for (const spec of unit.specs) {
      await deps.validateTaskPolicy?.(wf, spec);
    }
    await guard.check();
    if (await deps.repo.cancellation(wf.id)) return ts;
    try {
      if (group) await deps.k8s.createJobSet!(wf.namespace, group.jobSet);else await deps.k8s.createJob(wf.namespace, compiled[0].job);
    } catch (e) {
      // A 409 or transport timeout can be a successful create whose response was lost.
      const adopted = unit.group ? await deps.k8s.getJobSet!(wf.namespace, first.jobName!) : await deps.k8s.getJob(wf.namespace, first.jobName!);
      if (!adopted) throw e;
      owned(adopted, wf, first);
      if (first.topologyPlan) assertWorkloadPlan(adopted, first.topologyPlan);
    }
  }
  const confirmed = existing ?? (unit.group ? await deps.k8s.getJobSet!(wf.namespace, first.jobName!) : await deps.k8s.getJob(wf.namespace, first.jobName!));
  if (!confirmed) throw new Error('workload creation is not yet observable; retaining launch intent');
  owned(confirmed, wf, first);
  if (first.topologyPlan) assertWorkloadPlan(confirmed, first.topologyPlan);
  const updated = ts.map(t => ({
    ...t,
    phase: (queueForNamespace(wf.namespace, wf.spec.workflow.queue) ? 'QUEUED' : 'PENDING') as TaskPhase,
    jobUid: confirmed.metadata.uid,
    updatedAt: now,
    message: undefined
  }));
  await deps.repo.putTasks(updated, guard.lease);
  await event(wf, deps, 'TaskLaunched', `created/adopted ${first.workloadKind} ${first.jobName}`, first.name);
  return updated;
}
async function cleanup(wf: Workflow, unit: Unit, tasks: Task[], deps: ControllerDeps, guard: LeaseGuard): Promise<boolean> {
  await guard.check();
  const first = tasks[0];
  if (unit.group && first.attemptEpoch) await deps.groupRuntime!.fence(wf, unit.name, first.attemptEpoch, guard.signal);
  if (deps.cleanupCheckpointUploads && !await deps.cleanupCheckpointUploads(wf, {
    signal: guard.signal, taskNames: tasks.map(task => task.name), attempt: first.attempts,
  })) return false;
  // Successful computation must retain publication permission through
  // FINALIZING. Other cleanup paths also wait for collectors when the original
  // workload Job is already absent.
  if (first.cleanupTarget !== 'SUCCEEDED' && deps.cancelArtifacts && !(await deps.cancelArtifacts(wf, {
    signal: guard.signal,
    taskNames: tasks.map(task => task.name),
    attempt: first.attempts,
  }))) return false;
  if (deps.cancelSessions && !(await deps.cancelSessions(wf, {
    signal: guard.signal,
    groupId: unit.group?.name,
    attempt: first.attempts
  }))) return false;
  await guard.check();
  if (!first.jobName) return true;
  const get = () => unit.group ? deps.k8s.getJobSet!(wf.namespace, first.jobName!) : deps.k8s.getJob(wf.namespace, first.jobName!);
  const root = await get();
  if (root) {
    owned(root, wf, first);
    await guard.check();
    if (unit.group) await deps.k8s.deleteJobSet!(wf.namespace, first.jobName);else await deps.k8s.deleteJob(wf.namespace, first.jobName);
  }
  if (await get()) return false;
  const selector = unit.group ? `${LABEL_WF}=${wf.id},pai.aws/group=${unit.name},pai.aws/epoch=${first.attemptEpoch}` : `job-name=${first.jobName}`;
  return (await deps.k8s.listPods(wf.namespace, selector)).length === 0;
}
function backoff(unit: Unit): {
  max_retries: number;
  backoff_seconds?: number;
} {
  return unit.group?.retry ?? unit.specs.find(t => t.lead)?.retry ?? unit.specs[0].retry;
}
function exitAction(spec: TaskSpec, code: number | undefined): 'COMPLETE' | 'FAIL' | 'RESCHEDULE' | undefined {
  if (code === undefined) return;
  for (const [action, range] of Object.entries(spec.exitActions ?? {})) if (range !== undefined && exitRanges(range).includes(code)) return action as 'COMPLETE' | 'FAIL' | 'RESCHEDULE';
}
async function reconcileUnit(wf: Workflow, unit: Unit, current: Task[], all: Task[], deps: ControllerDeps, guard: LeaseGuard, cancel: boolean): Promise<Task[]> {
  let tasks = current;
  const now = deps.now(),
    iso = now.toISOString();
  const persist = async (next: Task[]) => {
    const previous = tasks;
    await deps.repo.putTasks(next, guard.lease);
    tasks = next;
    for (const t of next) if (previous.find(p => p.name === t.name)?.phase !== t.phase) await event(wf, deps, `Task${cap(t.phase)}`, t.message ?? `${t.name} ${t.phase.toLowerCase()}`, t.name);
    return next;
  };
  const stop = async (target: NonNullable<Task['cleanupTarget']>, reason: string, retryAt?: string) => {
    await persist(tasks.map(t => ({
      ...t,
      phase: 'CANCELLING',
      cleanupTarget: target,
      message: reason,
      failureReason: reason,
      nextRetryAt: retryAt,
      updatedAt: iso
    })));
  };
  const fail = async (reason: string, forceFail = false) => {
    const retry = backoff(unit),
      attempt = tasks[0].attempts;
    const retryable = !forceFail && attempt <= retry.max_retries;
    await stop(retryable ? 'RETRY_WAIT' : 'FAILED', reason, retryable ? new Date(now.getTime() + Math.min(3600, (retry.backoff_seconds ?? 10) * 2 ** Math.max(0, attempt - 1)) * 1000).toISOString() : undefined);
  };
  try {
    if (cancel && !tasks.every(t => t.phase === 'CANCELLED')) await stop('CANCELLED', 'cancellation requested');
    if (tasks.some(t => t.phase === 'CANCELLING')) {
      if (!(await cleanup(wf, unit, tasks, deps, guard))) return tasks;
      const next = tasks.map(t => ({
        ...t,
        phase: (t.cleanupTarget === 'SUCCEEDED' ? 'FINALIZING' : t.cleanupTarget ?? 'FAILED') as TaskPhase,
        updatedAt: iso,
        finishedAt: ['FAILED', 'CANCELLED'].includes(t.cleanupTarget ?? '') ? iso : undefined
      }));
      await persist(next);
      if (next.some(t => t.phase === 'RETRY_WAIT')) await event(wf, deps, 'RetryScheduled', tasks[0].nextRetryAt ?? '', tasks[0].name);
    }
    if (tasks.every(t => TERMINAL_TASK.has(t.phase))) return tasks;
    if (tasks.some(t => t.phase === 'FINALIZING')) {
      const done: Task[] = [];
      for (const t of tasks) done.push(TERMINAL_TASK.has(t.phase) ? t : await finalizeTask(wf, unit.specs.find(s => s.name === t.name)!, t, deps, guard));
      return persist(done);
    }
    if (tasks.every(t => t.phase === 'RETRY_WAIT')) {
      if (tasks.some(t => t.nextRetryAt && Date.parse(t.nextRetryAt) > now.getTime())) return tasks;
      return await launch(wf, unit, tasks, all, deps, guard);
    }
    if (tasks.every(t => t.phase === 'WAITING')) return tasks;
    let first = tasks[0];
    const timeouts = unit.group?.timeout ?? wf.spec.workflow.timeout;
    if (first.phase === 'LAUNCHING') {
      if (first.queuedAt && now.getTime() - Date.parse(first.queuedAt) >= durationToSeconds(timeouts.queue_timeout) * 1000) await fail('queue timeout during workload launch');else return await launch(wf, unit, tasks, all, deps, guard);
    } else if (first.topologyPlan) {
      if (!deps.topologyInventory) throw new TopologyError('CONFIG', 'topology inventory provider was removed during the attempt');
      const inventory = await deps.topologyInventory(wf, guard.signal);
      const selector = `${LABEL_WF}=${wf.id},pai.aws/epoch=${first.attemptEpoch}`;
      const pods = await deps.k8s.listPods(wf.namespace, selector);
      await guard.check();
      const observed = observePlacement(first.topologyPlan, inventory, wf.spec, unit.specs, pods, now);
      await persist(tasks.map((t, index) => index === 0 ? { ...t, topologyDiagnostics: observed } : t));
      first = tasks[0];
      if (observed.issue) await fail(`Topology placement failed: ${observed.issue}`);
    }
    if (tasks.some(t => t.phase === 'CANCELLING')) {
      // Placement failure takes precedence over application exit/leader completion.
    } else if (unit.group) {
      const root = await deps.k8s.getJobSet!(wf.namespace, first.jobName!);
      if (!root) await fail('JobSet disappeared');else {
        owned(root, wf, first);
        if (first.topologyPlan) assertWorkloadPlan(root, first.topologyPlan);
        const rootFailure = root.status?.conditions?.find(c => c.type === 'Failed' && c.status === 'True');
        if (rootFailure) await fail(`JobSet ${rootFailure.reason ?? 'failed'}: ${rootFailure.message ?? ''}`);else if (root.spec.suspend) {
          if (first.queuedAt && now.getTime() - Date.parse(first.queuedAt) >= durationToSeconds(timeouts.queue_timeout) * 1000) await fail('queue timeout waiting for JobSet admission');
        } else {
          const state = await deps.groupRuntime!.observe(wf, unit.name, first.attemptEpoch!, guard.signal);
          if (state.epoch !== first.attemptEpoch) throw new Error('stale group runtime epoch');
          const admittedAt = first.admittedAt ?? iso;
          const lead = unit.specs.find(t => t.lead)!;
          tasks = tasks.map(t => ({
            ...t,
            observedPhase: state.tasks[t.name]?.phase,
            exitCode: state.tasks[t.name]?.exitCode,
            ignoredByGroupPolicy: unit.group!.ignoreNonleadStatus && t.name !== lead.name && state.tasks[t.name]?.phase === 'FAILED'
          }));
          const relevant = unit.group.ignoreNonleadStatus ? [lead] : unit.specs;
          const failed = relevant.find(t => {
            const action = exitAction(t, state.tasks[t.name]?.exitCode);
            return action === 'FAIL' || action === 'RESCHEDULE' || state.tasks[t.name]?.phase === 'FAILED' && action !== 'COMPLETE';
          });
          if (failed) await fail(state.tasks[failed.name].message ?? `group task ${failed.name} failed`, exitAction(failed, state.tasks[failed.name].exitCode) === 'FAIL');else if (state.tasks[lead.name]?.phase === 'SUCCEEDED' || exitAction(lead, state.tasks[lead.name]?.exitCode) === 'COMPLETE') await stop('SUCCEEDED', 'group leader completed; terminating other members');else {
            const running = state.barrierReleased;
            tasks = tasks.map(t => ({
              ...t,
              phase: running ? 'RUNNING' : 'INITIALIZING',
              admittedAt,
              startedAt: running ? t.startedAt ?? state.startedAt ?? iso : undefined,
              updatedAt: iso
            }));
            if (!running && now.getTime() - Date.parse(admittedAt) >= durationToSeconds(timeouts.start_timeout) * 1000) await fail('group start timeout before barrier');else if (running && now.getTime() - Date.parse(tasks[0].startedAt!) >= durationToSeconds(timeouts.exec_timeout) * 1000) await fail('group execution timeout');else await persist(tasks);
          }
        }
      }
    } else {
      const job = await deps.k8s.getJob(wf.namespace, first.jobName!);
      if (job) {
        owned(job, wf, first);
        if (first.topologyPlan) assertWorkloadPlan(job, first.topologyPlan);
      }
      const pods = await deps.k8s.listPods(wf.namespace, `job-name=${first.jobName}`);
      const queue = job ? await deps.k8s.queueState(wf.namespace, first.jobName!) : 'unknown';
      const d = deriveTaskPhase(job, pods, queue, first.replicas);
      const exits = pods.flatMap(p => p.status?.containerStatuses ?? []).filter(s => s.name === 'main').map(s => s.state?.terminated?.exitCode).filter((code): code is number => code !== undefined);
      const code = exits.find(code => code !== 0) ?? exits[0];
      // Persisted launch mode survives a controller configuration change. Older
      // attempts use the compiler marker/project/checkpoint contract as fallback.
      const wrapped = first.runtimeWrapped ?? Boolean(wf.projectId || unit.specs[0].checkpoint?.length || job?.metadata.annotations?.['pai.aws/runtime-wrapper'] === 'true');
      let complete = false;
      let failure: { message: string; forceFail: boolean } | undefined;
      if (wrapped) {
        const observed = await readTaskRuntimeOutcome(deps.repo, wf, unit.specs[0], first, guard.signal);
        first = { ...first, runtimeWrapped: true, runtimeFailure: observed.runtimeFailure, observedPhase: observed.phase, exitCode: observed.exitCode, wrapperExitCode: code };
        tasks = [first];
        if (observed.runtimeFailure) failure = { message: observed.message ?? 'Runtime failed', forceFail: false };
        else if (observed.action === 'FAIL' || observed.action === 'RESCHEDULE') failure = { message: observed.message ?? `application exit ${observed.exitCode}`, forceFail: observed.action === 'FAIL' };
        else if (d.phase === 'FAILED' || exits.includes(125)) {
          first = { ...first, runtimeFailure: true };
          tasks = [first];
          failure = { message: `Runtime wrapper failed${code === undefined ? '' : ` (exit ${code})`}: ${d.message ?? 'completion was not confirmed'}`, forceFail: false };
        } else if (d.phase === 'SUCCEEDED') {
          complete = observed.action === 'COMPLETE';
          if (!complete) {
            first = { ...first, runtimeFailure: true };
            tasks = [first];
            failure = { message: 'Job completed without current terminal runtime reports for every replica', forceFail: false };
          }
        }
      } else {
        // Legacy tasks without a wrapper still expose original application exits.
        const actions = exits.map(exit => exitAction(unit.specs[0], exit));
        const action = actions.includes('FAIL') ? 'FAIL' : actions.includes('RESCHEDULE') ? 'RESCHEDULE' : exits.length >= first.replicas && exits.every((exit, index) => actions[index] === 'COMPLETE' || exit === 0) ? 'COMPLETE' : undefined;
        if (d.phase === 'FAILED' || action === 'RESCHEDULE' || action === 'FAIL') {
          if (action === 'COMPLETE') complete = true;
          else failure = { message: d.message ?? `task exit ${code}`, forceFail: action === 'FAIL' };
        } else complete = d.phase === 'SUCCEEDED';
      }
      if (failure) await fail(failure.message, failure.forceFail);
      else if (complete) await persist([{
        ...first,
        phase: 'FINALIZING',
        exitCode: wrapped ? first.exitCode : code,
        updatedAt: iso
      }]);else {
        const admitted = queue === 'admitted' || pods.length > 0 || !!job && !job.spec.suspend && queue !== 'pending' && queue !== 'evicted';
        const phase = d.phase === 'PENDING' && admitted ? 'INITIALIZING' : d.phase;
        const task: Task = {
          ...first,
          phase,
          message: d.message,
          admittedAt: first.admittedAt ?? (admitted ? iso : undefined),
          startedAt: first.startedAt ?? (phase === 'RUNNING' ? d.startedAt ?? iso : undefined),
          updatedAt: iso
        };
        if (phase === 'QUEUED' && first.queuedAt && now.getTime() - Date.parse(first.queuedAt) >= durationToSeconds(timeouts.queue_timeout) * 1000) await fail('queue timeout waiting for admission');else if (phase === 'INITIALIZING' && task.admittedAt && now.getTime() - Date.parse(task.admittedAt) >= durationToSeconds(timeouts.start_timeout) * 1000) await fail('start timeout initializing workload');else if (phase === 'RUNNING' && task.startedAt && now.getTime() - Date.parse(task.startedAt) >= durationToSeconds(unit.specs[0].timeout ?? timeouts.exec_timeout) * 1000) await fail('execution timeout');else await persist([task]);
      }
    }
    // Complete synchronous deletes and publication in this pass, without delaying external confirmations.
    if (tasks.some(t => t.phase === 'CANCELLING')) {
      if (!(await cleanup(wf, unit, tasks, deps, guard))) return tasks;
      await persist(tasks.map(t => ({
        ...t,
        phase: (t.cleanupTarget === 'SUCCEEDED' ? 'FINALIZING' : t.cleanupTarget ?? 'FAILED') as TaskPhase,
        finishedAt: ['FAILED', 'CANCELLED'].includes(t.cleanupTarget ?? '') ? iso : undefined
      })));
    }
    if (tasks.some(t => t.phase === 'FINALIZING')) {
      const done: Task[] = [];
      for (const t of tasks) done.push(await finalizeTask(wf, unit.specs.find(s => s.name === t.name)!, t, deps, guard));
      await persist(done);
    }
    return tasks;
  } catch (e) {
    guard.signal.throwIfAborted();
    if (e instanceof TopologyError && (e.code === 'PLACEMENT' || e.code === 'CONFIG')) {
      // launch() may have persisted a newer intent before discovering this error.
      const durable = await deps.repo.listTasks(wf.id);
      tasks = unit.specs.map(s => durable.find(t => t.name === s.name)!);
      await fail(e.message, e.code === 'CONFIG');
      return tasks;
    }
    // launch() can persist a new attempt/placement before a transport failure.
    // Reload so the catch cannot roll the durable intent back to the prior attempt.
    const durable = await deps.repo.listTasks(wf.id);
    tasks = unit.specs.map(s => durable.find(t => t.name === s.name)!);
    // Transport errors never become fabricated terminal success/failure. The intent survives.
    return persist(tasks.map(t => ({
      ...t,
      message: message(e).slice(0, 500),
      updatedAt: iso
    })));
  }
}
export async function reconcileWorkflowInternal(wfIn: Workflow, deps: ControllerDeps): Promise<Workflow> {
  const current = await deps.repo.getWorkflow(wfIn.id);
  if (!current) throw notFound(`workflow ${wfIn.id}`);
  await assertWorkflowBackend(current, deps.repo);
  return runOnBackend(current, async () => {
    const result = await reconcileBoundWorkflow(current, { ...deps, dataBucket: backendConfig().eks?.dataBucket ?? deps.dataBucket });
    return result;
  }, deps.repo, deps.now, 'observe');
}
async function reconcileBoundWorkflow(wfIn: Workflow, deps: ControllerDeps): Promise<Workflow> {
  const result = await withRunLease(wfIn.id, deps, async guard => {
    let wf = await deps.repo.getWorkflow(wfIn.id);
    if (!wf) throw notFound(`workflow ${wfIn.id}`);
    wf = await deliverOutbox(wf, deps, guard);
    if (TERMINAL_WF.has(wf.status)) return wf;
    let tasks = await deps.repo.listTasks(wf.id);
    const replace = (updated: Task[]) => {
      const map = new Map(updated.map(t => [t.name, t]));
      tasks = tasks.map(t => map.get(t.name) ?? t);
    };
    let cancel = !!(await deps.repo.cancellation(wf.id));
    if (cancel) {
      wf = {
        ...wf,
        status: 'CANCELLING'
      };
      await deps.repo.putWorkflow(wf, guard.lease);
    }
    const plan = units(wf);
    for (const unit of plan) {
      await guard.check();
      cancel ||= !!(await deps.repo.cancellation(wf.id));
      const current = unit.specs.map(s => tasks.find(t => t.name === s.name)!);
      if (current.some(t => !t)) throw new Error('workflow task ledger is incomplete');
      if (!cancel && current.every(t => TERMINAL_TASK.has(t.phase))) continue;
      replace(await reconcileUnit(wf, unit, current, tasks, deps, guard, cancel));
    }
    // Native group deadlines consume that group's budget; independent sibling groups continue.
    const anyFailed = tasks.some(t => t.phase === 'FAILED' && !(t.groupId && /timeout/i.test(t.failureReason ?? '')));
    for (const unit of plan) {
      const current = unit.specs.map(s => tasks.find(t => t.name === s.name)!);
      if (current.every(t => TERMINAL_TASK.has(t.phase))) continue;
      cancel ||= !!(await deps.repo.cancellation(wf.id));
      if (cancel || anyFailed && wf.spec.workflow.on_failure === 'cancel_pending') {
        if (!cancel && current.every(t => t.phase === 'WAITING')) {
          const skipped = current.map(t => ({
            ...t,
            phase: 'SKIPPED' as const,
            message: 'upstream task failed',
            finishedAt: deps.now().toISOString()
          }));
          await deps.repo.putTasks(skipped, guard.lease);
          replace(skipped);
        } else replace(await reconcileUnit(wf, unit, current, tasks, deps, guard, true));
        continue;
      }
      if (!current.every(t => t.phase === 'WAITING')) continue;
      const depsNames = unit.specs.flatMap(t => t.inputs.flatMap(i => 'task' in i ? [i.task] : []));
      const upstream = depsNames.map(n => tasks.find(t => t.name === n)!);
      if (upstream.some(t => ['FAILED', 'CANCELLED', 'SKIPPED'].includes(t.phase))) {
        const skipped = current.map(t => ({
          ...t,
          phase: 'SKIPPED' as const,
          message: 'upstream task did not succeed',
          finishedAt: deps.now().toISOString()
        }));
        await deps.repo.putTasks(skipped, guard.lease);
        replace(skipped);
      } else if (upstream.every(t => t.phase === 'SUCCEEDED')) {
        try {
          replace(await launch(wf, unit, current, tasks, deps, guard));
        } catch (e) {
          await guard.check();
          const durable = await deps.repo.listTasks(wf.id);
          const failed = durable.filter(t => unit.specs.some(s => s.name === t.name)).map(t => ({
            ...t,
            message: message(e).slice(0, 500)
          }));
          await deps.repo.putTasks(failed, guard.lease);
          replace(failed);
        }
      }
    }
    const allTerminal = tasks.every(t => TERMINAL_TASK.has(t.phase));
    const status = cancel ? allTerminal ? 'CANCELLED' : 'CANCELLING' : allTerminal ? tasks.every(t => t.phase === 'SUCCEEDED') ? 'SUCCEEDED' : 'FAILED' : tasks.some(t => t.phase === 'FINALIZING') ? 'FINALIZING' : tasks.some(t => t.phase !== 'WAITING') ? 'RUNNING' : 'PENDING';
    const now = deps.now().toISOString(),
      failed = tasks.find(t => t.phase === 'FAILED');
    const previous = wf.status;
    wf = {
      ...wf,
      status,
      updatedAt: now,
      startedAt: wf.startedAt ?? (status !== 'PENDING' ? now : undefined),
      finishedAt: TERMINAL_WF.has(status) ? now : undefined,
      succeededCount: tasks.filter(t => t.phase === 'SUCCEEDED').length,
      failedCount: tasks.filter(t => t.phase === 'FAILED').length,
      message: failed ? `task ${failed.name}: ${failed.message}` : cancel ? 'cancellation requested' : wf.message
    };
    if (TERMINAL_WF.has(status)) {
      await deps.repo.finishWorkflow(wf, ['complete', 'notify'], guard.lease);
      if (previous !== status) await event(wf, deps, `Workflow${cap(status)}`, wf.message ?? 'all tasks succeeded');
      wf = await deliverOutbox(wf, deps, guard);
    } else await deps.repo.putWorkflow(wf, guard.lease);
    return wf;
  });
  return result ?? (await deps.repo.getWorkflow(wfIn.id)) ?? wfIn;
}
export async function cancelWorkflowInternal(id: string, actor: string, deps: ControllerDeps): Promise<Workflow> {
  const wf = await deps.repo.getWorkflow(id);
  if (!wf) throw notFound(`workflow ${id}`);
  if (wf.status === 'CANCELLED') return wf;
  if (TERMINAL_WF.has(wf.status)) throw badRequest(`workflow is already ${wf.status}`);
  await deps.repo.requestCancellation(id, actor, deps.now().toISOString());
  const updated = await reconcileWorkflowInternal(wf, deps);
  // A concurrent holder will observe durable intent; report pending immediately.
  return TERMINAL_WF.has(updated.status) ? updated : {
    ...updated,
    status: 'CANCELLING'
  };
}
export async function deleteWorkflowInternal(id: string, deps: ControllerDeps): Promise<void> {
  const wf = await deps.repo.getWorkflow(id);
  if (!wf) return;
  await assertWorkflowBackend(wf, deps.repo);
  return runOnBackend(wf, () => deleteBoundWorkflow(wf, deps), deps.repo, deps.now, 'observe');
}
async function deleteBoundWorkflow(wf: Workflow, deps: ControllerDeps): Promise<void> {
  const id = wf.id;
  if (!TERMINAL_WF.has(wf.status)) throw badRequest('cancel the workflow before deleting it');
  const deleted = await withRunLease(id, deps, async guard => {
    const tasks = await deps.repo.listTasks(id);
    for (const unit of units(wf)) if (!(await cleanup(wf, unit, unit.specs.map(s => tasks.find(t => t.name === s.name)!), deps, guard))) throw badRequest('external cleanup is still pending');
    await deps.k8s.deleteByLabel(wf.namespace, 'configmaps', `${LABEL_WF}=${id}`);
    await deps.k8s.deleteByLabel(wf.namespace, 'secrets', `${LABEL_WF}=${id}`);
    await deps.repo.deleteWorkflow(id);
    return true;
  });
  if (!deleted) throw badRequest('workflow is currently being reconciled');
}
