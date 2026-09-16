import { inputPlan } from './inputs';
import { CheckpointRestoreService } from './restore';
import { CheckpointService } from './uploads';
import type { ObjectStorage } from './storage';
import { z } from 'zod';
import { HttpError } from '../errors';
import type { Repo } from '../store/repo';
import { TERMINAL_WF, type Workflow } from '../store/types';
import type { TaskSpec } from '../workflow/schema';
import type { GroupRuntimeState } from '../workflow/ports';
import { mintCapability, verifyCapability, gone, groupFor, type Capability } from './capability';
import { currentContext, guardChecks, replicaIndex, emptyMeta, metaKey, memberKey, fenceKey, actionFor, type AuthContext, type Participant, type RuntimeMeta } from './ledger';
import { backendId } from '../backends/registry';
export interface BrokerDeps {
  repo: Repo;
  now: () => Date;
  signingKey: string;
  apiUrl: string;
  artifactBucket?: string;
  storage?: ObjectStorage;
}
const stateSchema = z.object({
  phase: z.enum(['INITIALIZING', 'RUNNING', 'SUCCEEDED', 'FAILED']),
  ready: z.boolean(),
  replica: z.number().int().nonnegative(),
  exitCode: z.number().int().min(0).max(65535).optional(),
  message: z.string().max(2000).optional()
}).strict();
export class RuntimeBroker {
  constructor(readonly deps: BrokerDeps) {}
  environment(workflow: Workflow, task: TaskSpec, epoch: string, attempt: number): Record<string, string> {
    let url: URL;
    try {
      url = new URL(this.deps.apiUrl);
    } catch {
      throw new HttpError(503, 'Runtime API URL is not configured');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/' && url.pathname !== '') throw new HttpError(503, 'Runtime API URL must be an HTTP(S) origin');
    return {
      PAI_RUNTIME_ENDPOINT: url.origin,
      ...(workflow.backendId ? { PAI_RUNTIME_BACKEND_ID: workflow.backendId } : {}),
      PAI_RUNTIME_TOKEN: mintCapability(workflow, task, epoch, attempt, this.deps.signingKey, this.deps.now())
    };
  }
  mintMetricsCapability(workflow: Workflow, task: TaskSpec, epoch: string, attempt: number): string {
    return mintCapability(workflow, task, epoch, attempt, this.deps.signingKey, this.deps.now(), 'pai-mlflow');
  }
  async validateMetricsCapability(token: string) {
    return currentContext(this.deps.repo, verifyCapability(token, this.deps.signingKey, this.deps.now(), 'pai-mlflow'));
  }
  async authenticate(token: string) {
    return currentContext(this.deps.repo, verifyCapability(token, this.deps.signingKey, this.deps.now()));
  }
  async heartbeat(token: string): Promise<void> {
    const context = await this.authenticate(token),
      {
        claims
      } = context;
    const ok = await this.deps.repo.kv.transaction([...guardChecks(context), {
      kind: 'put',
      item: {
        pk: `WF#${claims.workflowId}`,
        sk: `RUNTIME#${claims.epoch}#HEARTBEAT#${claims.task}`,
        lastSeen: this.deps.now().toISOString()
      }
    }]);
    if (!ok) {
      await this.authenticate(token);
      throw new HttpError(409, 'Concurrent runtime state transition');
    }
  }
  async state(token: string, payload: unknown): Promise<void> {
    const parsed = stateSchema.safeParse(payload);
    if (!parsed.success) throw new HttpError(400, 'Invalid participant state');
    const input = parsed.data;
    if (['SUCCEEDED', 'FAILED'].includes(input.phase) && input.ready) throw new HttpError(400, 'Terminal participant cannot report ready');
    if (input.phase === 'SUCCEEDED' && input.exitCode !== 0) throw new HttpError(400, 'Success requires an observed zero exit code');
    for (let tries = 0; tries < 12; tries++) {
      const ctx = await this.authenticate(token);
      replicaIndex(ctx, input.replica);
      const {
        claims
      } = ctx;
      const key = memberKey(claims.workflowId, claims.epoch, claims.task, input.replica),
        mk = metaKey(claims.workflowId, claims.epoch);
      const old = (await this.deps.repo.kv.get(key.pk, key.sk)) as Participant | undefined;
      const stored = (await this.deps.repo.kv.get(mk.pk, mk.sk)) as RuntimeMeta | undefined,
        meta = stored ?? emptyMeta(ctx);
      if (old && ['SUCCEEDED', 'FAILED'].includes(old.phase)) {
        if (['SUCCEEDED', 'FAILED'].includes(input.phase) && (old.phase !== input.phase || old.exitCode !== input.exitCode)) throw new HttpError(409, 'Terminal participant outcome is immutable');
        if (!(await this.deps.repo.kv.transaction(guardChecks(ctx)))) {
          await this.authenticate(token);
          continue;
        }
        return;
      }
      if (old?.phase === 'RUNNING' && input.phase === 'INITIALIZING') {
        if (await this.deps.repo.kv.transaction(guardChecks(ctx))) return;
        continue;
      }
      if (input.phase === 'RUNNING' && (!old?.readyEver || ctx.group?.barrier !== false && !meta.released)) throw new HttpError(409, 'Participant barrier has not released');
      if (input.phase === 'SUCCEEDED' && old?.phase !== 'RUNNING') throw new HttpError(409, 'Success requires a running participant');
      const runtimeFailure = input.message?.startsWith('runtime-error:') ?? false;
      const lead = ctx.group?.tasks.find(t => t.lead);
      const coordinatedStop = !!lead && lead.name !== claims.task && !!meta.stopped && meta.leadComplete === lead.parallelism && !meta.runtimeFailure && !!input.message?.startsWith('group-stopped:');
      const member: Participant = {
        ...key,
        task: claims.task,
        replica: input.replica,
        phase: input.phase,
        ready: input.ready,
        readyEver: !!old?.readyEver || input.ready,
        processStarted: !!old?.processStarted || input.phase === 'RUNNING',
        revision: (old?.revision ?? 0) + 1,
        exitCode: input.exitCode,
        message: input.message?.replaceAll(token, '[redacted]'),
        updatedAt: this.deps.now().toISOString(),
        runtimeFailure,
        coordinatedStop
      };
      const next = {
        ...meta,
        revision: meta.revision + 1,
        readyCount: meta.readyCount + (!old?.readyEver && member.readyEver ? 1 : 0)
      };
      if (['SUCCEEDED', 'FAILED'].includes(input.phase)) {
        const action = runtimeFailure ? 'FAIL' : coordinatedStop ? 'COMPLETE' : actionFor(ctx.spec, input.exitCode);
        const isLead = !ctx.group || ctx.group.tasks.find(t => t.lead)?.name === claims.task;
        if (runtimeFailure) {
          next.stopped = true;
          next.runtimeFailure = claims.task;
        } else if (action === 'COMPLETE' && member.processStarted && isLead) {
          next.leadComplete++;
          if (next.leadComplete === ctx.spec.parallelism) next.stopped = true;
        } else if (action !== 'COMPLETE' && (isLead || !ctx.group?.ignoreNonleadStatus)) next.stopped = true;
      }
      const ok = await this.deps.repo.kv.transaction([...guardChecks(ctx), {
        kind: 'put',
        item: member,
        condition: old ? {
          equals: {
            revision: old.revision
          }
        } : {
          absent: true
        }
      }, {
        kind: 'put',
        item: next,
        condition: stored ? {
          equals: {
            revision: stored.revision
          }
        } : {
          absent: true
        }
      }]);
      if (ok) return;
    }
    throw new HttpError(409, 'Participant state contention; retry');
  }
  async barrier(token: string, replica: number): Promise<{
    released: boolean;
    stopped: boolean;
  }> {
    for (let tries = 0; tries < 12; tries++) {
      const ctx = await this.authenticate(token);
      replicaIndex(ctx, replica);
      const {
        claims
      } = ctx;
      const key = metaKey(claims.workflowId, claims.epoch),
        stored = (await this.deps.repo.kv.get(key.pk, key.sk)) as RuntimeMeta | undefined,
        meta = stored ?? emptyMeta(ctx);
      const keyMember = memberKey(claims.workflowId, claims.epoch, claims.task, replica),
        member = (await this.deps.repo.kv.get(keyMember.pk, keyMember.sk)) as Participant | undefined;
      const ready = !!member?.readyEver && (ctx.group?.barrier === false || !ctx.group || meta.readyCount === meta.expected);
      if (ready && !meta.stopped && !meta.released) {
        const next = {
          ...meta,
          revision: meta.revision + 1,
          released: true,
          releasedAt: this.deps.now().toISOString()
        };
        if (!(await this.deps.repo.kv.transaction([...guardChecks(ctx), {
          kind: 'put',
          item: next,
          condition: stored ? {
            equals: {
              revision: stored.revision
            }
          } : {
            absent: true
          }
        }]))) continue;
        return {
          released: true,
          stopped: false
        };
      }
      if (!(await this.deps.repo.kv.transaction(guardChecks(ctx)))) continue;
      return {
        released: !!meta.released && !!member?.readyEver,
        stopped: !!meta.stopped
      };
    }
    await this.authenticate(token);
    throw new HttpError(409, 'Barrier state contention; retry');
  }
  planUploads(token: string, payload: unknown) {
    return new CheckpointService(this.deps, t => this.authenticate(t)).plan(token, payload);
  }
  completeUploads(token: string, payload: unknown, signal?: AbortSignal) {
    return new CheckpointService(this.deps, t => this.authenticate(t)).complete(token, payload, signal);
  }
  async inputs(token: string) {
    const context = await this.authenticate(token);
    const plan = await inputPlan(this.deps, context);
    await this.authenticate(token);
    return plan;
  }
  checkpoints(token: string, replica: number, signal?: AbortSignal) {
    return new CheckpointRestoreService(this.deps, token => this.authenticate(token)).plan(token, replica, signal);
  }
  async observe(workflow: Workflow, groupId: string, epoch: string, signal: AbortSignal): Promise<GroupRuntimeState> {
    signal.throwIfAborted();
    const wf = await this.deps.repo.getWorkflow(workflow.id),
      group = wf?.spec.workflow.groups?.find(g => g.name === groupId);
    if (wf && backendId(wf.backendId) !== backendId(workflow.backendId)) throw gone();
    if (!wf || !group || wf.projectId !== workflow.projectId || wf.namespace !== workflow.namespace || TERMINAL_WF.has(wf.status) || wf.status === 'CANCELLING' || (await this.deps.repo.cancellation(wf.id))) throw gone();
    const tasks = await this.deps.repo.listTasks(wf.id);
    if (group.tasks.some(t => tasks.find(row => row.name === t.name)?.attemptEpoch !== epoch)) throw gone();
    const fk = fenceKey(wf.id, epoch);
    if (await this.deps.repo.kv.get(fk.pk, fk.sk)) throw gone();
    const rows = (await this.deps.repo.kv.query(`WF#${wf.id}`, `RUNTIME#${epoch}#MEMBER#`)) as Participant[];
    const mk = metaKey(wf.id, epoch),
      meta = (await this.deps.repo.kv.get(mk.pk, mk.sk)) as RuntimeMeta | undefined;
    const result: GroupRuntimeState = {
      epoch,
      barrierReleased: !!meta?.released,
      startedAt: meta?.releasedAt,
      tasks: {}
    };
    for (const spec of group.tasks) {
      const members = rows.filter(row => row.task === spec.name && row.replica >= 0 && row.replica < spec.parallelism);
      const terminal = (row: Participant) => ['SUCCEEDED', 'FAILED'].includes(row.phase);
      const failed = members.find(row => terminal(row) && (row.runtimeFailure || !row.coordinatedStop && actionFor(spec, row.exitCode) !== 'COMPLETE'));
      const complete = members.length === spec.parallelism && members.every(row => terminal(row) && !row.runtimeFailure && (row.coordinatedStop || row.processStarted && actionFor(spec, row.exitCode) === 'COMPLETE'));
      if (failed) result.tasks[spec.name] = {
        phase: 'FAILED',
        exitCode: failed.runtimeFailure ? undefined : failed.exitCode,
        message: failed.message
      };else if (complete) result.tasks[spec.name] = {
        phase: 'SUCCEEDED',
        exitCode: members.some(row => row.coordinatedStop) ? undefined : members[0].exitCode,
        message: members.some(row => row.phase === 'FAILED') ? 'All replicas satisfied COMPLETE policy; raw outcomes remain in participant records' : undefined
      };else result.tasks[spec.name] = {
        phase: members.some(row => row.processStarted) ? 'RUNNING' : 'INITIALIZING'
      };
    }
    if (meta?.runtimeFailure) {
      const lead = group.tasks.find(t => t.lead)!;
      result.tasks[lead.name] = {
        phase: 'FAILED',
        message: `Group runtime failure in ${meta.runtimeFailure}; raw member states are preserved`
      };
    }
    signal.throwIfAborted();
    return result;
  }
  async fence(workflow: Workflow, groupId: string, epoch: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const key = fenceKey(workflow.id, epoch);
    if (await this.deps.repo.kv.get(key.pk, key.sk)) return;
    const wf = await this.deps.repo.getWorkflow(workflow.id),
      group = wf?.spec.workflow.groups?.find(g => g.name === groupId);
    if (wf && backendId(wf.backendId) !== backendId(workflow.backendId)) throw gone();
    if (!wf || !group || wf.projectId !== workflow.projectId || wf.namespace !== workflow.namespace) throw gone();
    const tasks = await this.deps.repo.listTasks(wf.id);
    if (group.tasks.some(t => tasks.find(row => row.name === t.name)?.attemptEpoch !== epoch)) throw gone();
    await this.deps.repo.kv.put({
      ...key,
      groupId,
      epoch,
      projectId: wf.projectId,
      namespace: wf.namespace,
      fencedAt: this.deps.now().toISOString()
    }, 'not_exists');
  }
}
