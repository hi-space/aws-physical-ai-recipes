import { HttpError } from '../errors';
import type { Repo } from '../store/repo';
import type { Item } from '../store/dynamo';
import type { Write } from '../store/atomic';
import { TERMINAL_WF, TERMINAL_TASK, type Task, type Workflow } from '../store/types';
import type { GroupSpec, TaskSpec } from '../workflow/schema';
import { exitRanges } from '../workflow/validation';
import { gone, groupFor, type Capability } from './capability';
import { backendId } from '../backends/registry';
export interface AuthContext {
  claims: Capability;
  workflow: Workflow;
  task: Task;
  spec: TaskSpec;
  group?: GroupSpec;
}
export interface Participant extends Item {
  task: string;
  replica: number;
  phase: 'INITIALIZING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  ready: boolean;
  readyEver: boolean;
  processStarted: boolean;
  revision: number;
  exitCode?: number;
  message?: string;
  updatedAt: string;
  runtimeFailure: boolean;
  coordinatedStop?: boolean;
}
export interface RuntimeMeta extends Item {
  revision: number;
  readyCount: number;
  leadComplete: number;
  expected: number;
  released?: boolean;
  releasedAt?: string;
  stopped?: boolean;
  runtimeFailure?: string;
}
export const fenceKey = (wf: string, epoch: string) => ({
  pk: `WF#${wf}`,
  sk: `FENCE#${epoch}`
});
export const metaKey = (wf: string, epoch: string) => ({
  pk: `WF#${wf}`,
  sk: `RUNTIME#${epoch}#META`
});
export const memberKey = (wf: string, epoch: string, task: string, replica: number) => ({
  pk: `WF#${wf}`,
  sk: `RUNTIME#${epoch}#MEMBER#${task}#${replica}`
});
export function expectedMembers(context: AuthContext) {
  return (context.group?.tasks ?? [context.spec]).flatMap(t => Array.from({
    length: t.parallelism
  }, (_, replica) => ({
    task: t.name,
    replica
  })));
}
export function guardChecks(context: AuthContext): Write[] {
  const {
    claims,
    workflow,
    task
  } = context;
  return [{
    kind: 'check',
    pk: `WF#${claims.workflowId}`,
    sk: 'META',
    condition: {
      equals: {
        status: workflow.status,
        namespace: workflow.namespace,
        ...(workflow.backendId ? { backendId: workflow.backendId } : {}),
        ...(workflow.projectId ? {
          projectId: workflow.projectId
        } : {})
      }
    }
  }, {
    kind: 'check',
    pk: `WF#${claims.workflowId}`,
    sk: `TASK#${claims.task}`,
    condition: {
      equals: {
        attempts: claims.attempt,
        attemptEpoch: claims.epoch,
        phase: task.phase
      }
    }
  }, {
    kind: 'check',
    ...fenceKey(claims.workflowId, claims.epoch),
    condition: {
      absent: true
    }
  }, {
    kind: 'check',
    pk: `WF#${claims.workflowId}`,
    sk: 'CANCEL',
    condition: {
      absent: true
    }
  }];
}
export async function currentContext(repo: Repo, claims: Capability): Promise<AuthContext> {
  const workflow = await repo.getWorkflow(claims.workflowId);
  if (workflow && backendId(workflow.backendId) !== backendId(claims.backendId)) throw gone();
  const task = (await repo.kv.get(`WF#${claims.workflowId}`, `TASK#${claims.task}`)) as (Item & Task) | undefined;
  if (!workflow || !task || TERMINAL_WF.has(workflow.status) || workflow.status === 'CANCELLING' || TERMINAL_TASK.has(task.phase) || ['CANCELLING', 'RETRY_WAIT', 'WAITING'].includes(task.phase) || (workflow.projectId ?? 'legacy') !== claims.projectId || workflow.namespace !== claims.namespace || task.attempts !== claims.attempt || task.attemptEpoch !== claims.epoch) throw gone();
  const spec = workflow.spec.workflow.tasks.find(t => t.name === claims.task),
    group = groupFor(workflow, claims.task);
  if (!spec || (group?.name ?? `task:${claims.task}`) !== claims.groupId) throw gone();
  const fence = fenceKey(claims.workflowId, claims.epoch);
  if ((await repo.kv.get(`WF#${claims.workflowId}`, 'CANCEL')) || (await repo.kv.get(fence.pk, fence.sk))) throw gone();
  return {
    claims,
    workflow,
    task,
    spec,
    group
  };
}
export function actionFor(spec: TaskSpec, exitCode?: number): 'COMPLETE' | 'FAIL' | 'RESCHEDULE' {
  if (exitCode === undefined) return 'FAIL';
  for (const [action, range] of Object.entries(spec.exitActions ?? {})) if (range !== undefined && exitRanges(range).includes(exitCode)) return action as 'COMPLETE' | 'FAIL' | 'RESCHEDULE';
  return exitCode === 0 ? 'COMPLETE' : 'FAIL';
}
export function replicaIndex(context: AuthContext, replica: number): void {
  if (!Number.isInteger(replica) || replica < 0 || replica >= context.spec.parallelism) throw new HttpError(400, 'Replica is not a declared task participant');
}
export function emptyMeta(context: AuthContext): RuntimeMeta {
  return {
    ...metaKey(context.claims.workflowId, context.claims.epoch),
    revision: 0,
    readyCount: 0,
    leadComplete: 0,
    expected: expectedMembers(context).length
  };
}
