import type { Pod } from '../k8s/resources';
import { getPod, listPods } from '../k8s/resources';
import type { Workflow, Task } from '../store/types';
import { backendId } from '../backends/registry';
import { runOnBackend } from '../backends/context';
import { assertWorkflowBackend } from '../backends/binding';
import { HttpError } from '../errors';
import { scopeId, LogArchive } from './archive';
import { capturePodLogs } from './capture';
import { openPodLogStream, podInventory, type Inventory } from './kubernetes';
import type { LogDeps, LogScope } from './types';

export interface CollectorDeps extends LogDeps {
  /** Resolve only approved task secret values; required even if the task has no secrets (return []). */
  secrets(wf: Workflow, task: Task, pod: Pod, container: string): Promise<string[]>;
  getPod?: typeof getPod;
  listPods?: typeof listPods;
  open?: typeof openPodLogStream;
}
interface Active { scope: LogScope; stop: AbortController; done: Promise<void> }
const selector = (wf: Workflow) => `app.kubernetes.io/managed-by=physical-ai-dashboard,pai.aws/workflow-id=${wf.id}`;
function identity(wf: Workflow, task: Task, pod: Pod, s: LogScope) {
  const l = pod.metadata.labels;
  const status = [...(pod.status?.containerStatuses ?? []), ...(pod.status?.initContainerStatuses ?? [])].find(c => c.name === s.container);
  return wf.projectId === s.projectId && wf.namespace === s.namespace && backendId(wf.backendId) === s.backendId && wf.backendConfigHash === s.backendConfigHash &&
    task.name === s.taskName && task.attempts === s.attempt && task.attemptEpoch === s.epoch &&
    pod.metadata.uid === s.podUid && pod.metadata.name === s.podName && pod.metadata.namespace === s.namespace &&
    l?.['app.kubernetes.io/managed-by'] === 'physical-ai-dashboard' && l['pai.aws/workflow-id'] === wf.id && l['pai.aws/task'] === task.name &&
    l['pai.aws/project'] === s.projectId && backendId(l['pai.aws/backend']) === s.backendId &&
    l['pai.aws/attempt'] === String(s.attempt) && l['pai.aws/epoch'] === s.epoch &&
    Number(l['batch.kubernetes.io/job-completion-index'] ?? 0) === s.member && status?.restartCount === s.restartCount &&
    [...pod.spec.containers, ...(pod.spec.initContainers ?? [])].some(c => c.name === s.container);
}
/** One instance per controller process, independent of API readers. No workload mutations. */
export function createLogCollector(deps: CollectorDeps) {
  const active = new Map<string, Active>(), failures = new Set<string>(), archive = new LogArchive(deps);
  const blockedScope = async (s: LogScope) => (await Promise.all(['ALL', s.taskName].flatMap(task =>
    ['ALL', String(s.attempt)].map(attempt => deps.repo.kv.get(`WF#${s.workflowId}`, `LOG_DRAIN#${task}#${attempt}`))))).some(Boolean);
  async function validate(scope: LogScope) {
    const wf = await deps.repo.getWorkflow(scope.workflowId);
    const task = (await deps.repo.listTasks(scope.workflowId)).find(t => t.name === scope.taskName);
    if (!wf || !task) return false;
    await assertWorkflowBackend(wf, deps.repo);
    const pod = await (deps.getPod ?? getPod)(scope.namespace, scope.podName);
    return !!pod && identity(wf, task, pod, scope);
  }
  async function reconcile(wf: Workflow, inventory?: Inventory) {
    return runOnBackend(wf, async () => {
      await assertWorkflowBackend(wf, deps.repo);
      if (!wf.projectId) return;
      const pods = inventory?.pods ?? await (deps.listPods ?? listPods)(wf.namespace, selector(wf));
      const tasks = await deps.repo.listTasks(wf.id);
      if (failures.has(wf.id)) { failures.delete(wf.id); throw new HttpError(503, 'A log capture failed; captured history may be incomplete', 'log_capture_failed'); }
      if (inventory?.reset) {
        // An interrupted inventory cannot establish what happened to missing Pods.
        // End old captures explicitly; fresh identities can be reconciled after lease release.
        for (const item of active.values()) if (item.scope.workflowId === wf.id) item.stop.abort('watch-reset');
        const results = await Promise.allSettled([...active.values()].filter(a => a.scope.workflowId === wf.id).map(a => a.done));
        if (results.some(r => r.status === 'rejected')) throw new HttpError(503, 'Log capture reset failed');
      }
      for (const pod of pods) {
        const task = tasks.find(t => t.name === pod.metadata.labels?.['pai.aws/task']);
        if (!task?.attemptEpoch || !pod.metadata.uid) continue;
        const statuses = [...(pod.status?.containerStatuses ?? []), ...(pod.status?.initContainerStatuses ?? [])];
        for (const status of statuses) {
          if (!status.state?.running && !status.state?.terminated) continue;
          const scope: LogScope = { projectId: wf.projectId, backendId: backendId(wf.backendId), backendConfigHash: wf.backendConfigHash,
            namespace: wf.namespace, workflowId: wf.id, taskName: task.name, attempt: task.attempts, epoch: task.attemptEpoch,
            member: Number(pod.metadata.labels?.['batch.kubernetes.io/job-completion-index'] ?? 0), container: status.name,
            podName: pod.metadata.name, podUid: pod.metadata.uid, restartCount: status.restartCount };
          if (!identity(wf, task, pod, scope) || await blockedScope(scope)) continue;
          const id = scopeId(scope);
          if (active.has(id)) continue;
          if (active.size >= 64) throw new HttpError(503, 'Log collector concurrency limit reached', 'log_capture_capacity');
          const stop = new AbortController();
          // Attach a rejection handler immediately; reconciliation/drain still surfaces every failure.
          const done = (async () => {
            const secrets = await deps.secrets(wf, task, pod, status.name);
            const declared = wf.spec.workflow.tasks.find(t => t.name === task.name)?.credentials ?? {};
            const usesSecrets = Object.values(declared).some(mapping => Object.keys(mapping).length > 0) ||
              pod.spec.containers.some(c => c.env?.some(e => !!(e.valueFrom as { secretKeyRef?: unknown } | undefined)?.secretKeyRef));
            if (usesSecrets && !secrets.some(Boolean)) throw new HttpError(503, 'Log redaction secret resolution is incomplete', 'log_redaction_unavailable');
            await capturePodLogs(scope, stop.signal, {
              ...deps, secrets, validate, shouldStop: blockedScope, open: deps.open ?? openPodLogStream,
              finished: async s => {
                const current = await (deps.getPod ?? getPod)(s.namespace, s.podName);
                if (!current || current.metadata.uid !== s.podUid) return true;
                return !![...(current.status?.containerStatuses ?? []), ...(current.status?.initContainerStatuses ?? [])]
                  .find(c => c.name === s.container && c.restartCount === s.restartCount)?.state?.terminated;
              },
            });
          })();
          active.set(id, { scope, stop, done });
          void done.catch(() => { failures.add(wf.id); }).finally(() => { active.delete(id); });
        }
      }
      for (const a of active.values()) {
        if (a.scope.workflowId !== wf.id) continue;
        if (await blockedScope(a.scope)) a.stop.abort();
        else if (!pods.some(p => p.metadata.uid === a.scope.podUid)) a.stop.abort('pod-gone');
      }
    }, deps.repo, () => new Date((deps.now ?? Date.now)()), 'observe');
  }
  /** Optional continuous list/watch. Parent may instead call reconcile on each controller tick. */
  async function watch(workflowId: string, signal: AbortSignal) {
    const wf = await deps.repo.getWorkflow(workflowId);
    if (!wf?.projectId) throw new HttpError(404, 'Project workflow not found');
    await runOnBackend(wf, async () => {
      for await (const inventory of podInventory(wf.namespace, selector(wf), signal)) {
        const fresh = await deps.repo.getWorkflow(workflowId);
        if (!fresh || signal.aborted) break;
        await reconcile(fresh, inventory);
      }
    }, deps.repo, () => new Date((deps.now ?? Date.now)()), 'observe');
  }
  /** Let finite, already-terminated container logs reach EOF before installing a destructive drain fence. */
  async function settleCompleted(workflowId: string, filter: { taskNames?: string[]; attempt?: number; timeoutMs?: number } = {}) {
    const selected = [...active.values()].filter(a => a.scope.workflowId === workflowId &&
      (!filter.taskNames || filter.taskNames.includes(a.scope.taskName)) &&
      (filter.attempt === undefined || a.scope.attempt === filter.attempt));
    const pending = async () => {
      const finite = await Promise.all(selected.map(async item => {
        const pod = await (deps.getPod ?? getPod)(item.scope.namespace, item.scope.podName);
        const status = [...(pod?.status?.containerStatuses ?? []), ...(pod?.status?.initContainerStatuses ?? [])]
          .find(container => container.name === item.scope.container && container.restartCount === item.scope.restartCount);
        return pod?.metadata.uid === item.scope.podUid && status?.state?.terminated ? item : undefined;
      }));
      const results = await Promise.allSettled(finite.filter((item): item is Active => !!item).map(item => item.done));
      return results.every(result => result.status === 'fulfilled');
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return { settled: await Promise.race([pending(), new Promise<false>(resolve => {
        timer = setTimeout(() => resolve(false), Math.max(1, Math.min(filter.timeoutMs ?? 5000, 10_000)));
      })]) };
    } finally { clearTimeout(timer); }
  }
  /** Call before deletion/retry. Timeout is explicit; caller must not report a successful drain. */
  async function drain(workflowId: string, filter: { taskName?: string; attempt?: number; timeoutMs?: number } = {}) {
    await deps.repo.kv.put({ pk: `WF#${workflowId}`, sk: `LOG_DRAIN#${filter.taskName ?? 'ALL'}#${filter.attempt ?? 'ALL'}`, createdAt: new Date().toISOString() }, 'not_exists');
    const selected = [...active.values()].filter(a => a.scope.workflowId === workflowId && (!filter.taskName || a.scope.taskName === filter.taskName) &&
      (filter.attempt === undefined || a.scope.attempt === filter.attempt));
    for (const a of selected) a.stop.abort();
    const settle = async () => {
      const results = await Promise.allSettled(selected.map(a => a.done));
      if (results.some(r => r.status === 'rejected') || failures.has(workflowId)) { failures.delete(workflowId); throw new HttpError(503, 'Log capture/storage failed during drain', 'log_capture_failed'); }
      const tasks = await deps.repo.listTasks(workflowId);
      for (;;) {
        let pending = false;
        for (const task of tasks.filter(t => !filter.taskName || t.name === filter.taskName)) {
          const catalog = await archive.list(workflowId, task.name, filter.attempt);
          if (catalog.truncated) return false;
          for (const head of catalog.streams) {
            if (head.state !== 'open') continue;
            const lease = await archive.acquire(head.id);
            if (!lease) { pending = true; continue; } // Another controller still owns this capture.
            try { await archive.append(lease, 'drain', { kind: 'gap', reason: 'capture-stop' }); await archive.close(lease); }
            finally { await archive.release(lease); }
          }
        }
        if (!pending) return true;
        if (timedOut) return false;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    };
    let timer: ReturnType<typeof setTimeout> | undefined, timedOut = false;
    try {
      const result = await Promise.race([
        settle(),
        new Promise<false>(resolve => { timer = setTimeout(() => { timedOut = true; resolve(false); }, Math.max(1, Math.min(filter.timeoutMs ?? 10_000, 30_000))); }),
      ]);
      return { drained: result, coverage: 'captured-only' as const };
    } finally { clearTimeout(timer); }
  }
  return { reconcile, watch, settleCompleted, drain };
}
