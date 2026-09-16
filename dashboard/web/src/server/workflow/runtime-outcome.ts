import type { Repo } from '../store/repo';
import { TERMINAL_WF, type Task, type Workflow } from '../store/types';
import { actionFor, fenceKey, memberKey, type Participant } from '../runtime/ledger';
import type { TaskSpec } from './schema';
import type { TaskRuntimeOutcome } from './ports';

/**
 * Read the broker's original application observations, never normalized Pod exits.
 * The controller owns the run lease; scope, attempt and fence checks additionally
 * prevent adopting a stale runtime participant set.
 */
export async function readTaskRuntimeOutcome(
  repo: Repo, workflow: Workflow, spec: TaskSpec, task: Task, signal: AbortSignal,
): Promise<TaskRuntimeOutcome> {
  const epoch = task.attemptEpoch ?? '';
  const failure = (message: string, exitCode?: number): TaskRuntimeOutcome => ({
    epoch, phase: 'FAILED', action: 'FAIL', runtimeFailure: true, exitCode, message,
  });
  if (!epoch) return failure('Runtime attempt has no durable epoch');
  const currentScope = async () => {
    signal.throwIfAborted();
    const wf = await repo.getWorkflow(workflow.id);
    const current = await repo.kv.get(`WF#${workflow.id}`, `TASK#${task.name}`);
    const fence = fenceKey(workflow.id, epoch);
    return !!wf && wf.projectId === workflow.projectId && wf.namespace === workflow.namespace
      && !TERMINAL_WF.has(wf.status) && wf.status !== 'CANCELLING'
      && current?.attempts === task.attempts && current.attemptEpoch === epoch
      && !await repo.cancellation(workflow.id) && !await repo.kv.get(fence.pk, fence.sk);
  };
  if (!await currentScope()) return failure('Runtime attempt is fenced, cancelled, or superseded');
  const rows = await repo.kv.query(`WF#${workflow.id}`, `RUNTIME#${epoch}#MEMBER#${task.name}#`);
  if (!await currentScope()) return failure('Runtime attempt was fenced while reading its outcome');
  const members = rows.filter((row): row is Participant => {
    if (row.task !== task.name || !Number.isInteger(row.replica) || Number(row.replica) < 0 || Number(row.replica) >= task.replicas) return false;
    return row.sk === memberKey(workflow.id, epoch, task.name, Number(row.replica)).sk;
  });
  const runtimeFailed = members.find(row => row.runtimeFailure || row.message?.startsWith('runtime-error:'));
  if (runtimeFailed) return failure(runtimeFailed.message ?? 'Runtime or checkpoint publication failed', runtimeFailed.exitCode);

  const terminal = members.filter(row => row.phase === 'FAILED' || row.phase === 'SUCCEEDED');
  const invalid = terminal.find(row => !row.processStarted || !Number.isInteger(row.exitCode)
    || Number(row.exitCode) < 0 || Number(row.exitCode) > 255 || row.phase === 'SUCCEEDED' && row.exitCode !== 0);
  if (invalid) return failure(invalid.message ?? 'Runtime did not confirm a valid application termination', invalid.exitCode);

  // FAIL takes precedence over RESCHEDULE; a COMPLETE replica cannot hide either.
  for (const action of ['FAIL', 'RESCHEDULE'] as const) {
    const member = terminal.find(row => actionFor(spec, row.exitCode) === action);
    if (member) return { epoch, phase: member.phase, action, runtimeFailure: false, exitCode: member.exitCode, message: member.message };
  }
  if (terminal.length === task.replicas && new Set(terminal.map(row => row.replica)).size === task.replicas) {
    const failedApplication = terminal.find(row => row.phase === 'FAILED');
    return {
      epoch, phase: failedApplication ? 'FAILED' : 'SUCCEEDED', action: 'COMPLETE',
      runtimeFailure: false, exitCode: failedApplication?.exitCode ?? terminal[0].exitCode,
      message: failedApplication?.message,
    };
  }
  return {
    epoch, phase: members.some(row => row.processStarted) ? 'RUNNING' : 'INITIALIZING',
    runtimeFailure: false, message: 'Waiting for current runtime participant outcomes',
  };
}
