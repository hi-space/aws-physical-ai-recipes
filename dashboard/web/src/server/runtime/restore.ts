import { posix } from 'node:path';
import { z } from 'zod';
import { HttpError } from '../errors';
import { checkpointPath, checkpointSignature, checkpointURL, type CheckpointSource, type RecoveryTask, type RecoveryWorkflow } from '../workflow/checkpoints';
import type { BrokerDeps } from './broker';
import { replicaIndex, type AuthContext } from './ledger';
import { CheckpointService, checkpointIndexKey, type Plan, type CommittedCheckpointIndex } from './uploads';
import { selectPlanPage, type PlanPage } from './plan-pages';

const sourceSchema = z.object({
  workflowId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/),
  task: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
  attempt: z.number().int().positive().max(2147483647),
  epoch: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/),
}).strict();

export class CheckpointRestoreService {
  constructor(private readonly deps: BrokerDeps, private readonly authenticate: (token: string) => Promise<AuthContext>) {}

  private async sourceContext(current: AuthContext, source: CheckpointSource): Promise<AuthContext> {
    if (source.task !== current.claims.task || source.workflowId === current.workflow.id && source.attempt >= current.claims.attempt) {
      throw new HttpError(403, 'Checkpoint source is not a previous task attempt');
    }
    let workflow = current.workflow as RecoveryWorkflow;
    const seen = new Set<string>();
    while (workflow.id !== source.workflowId) {
      if (!workflow.retryOf || seen.has(workflow.id) || seen.size >= 32) throw new HttpError(403, 'Checkpoint source is outside server-recorded retry lineage');
      seen.add(workflow.id);
      const ancestor = await this.deps.repo.getWorkflow(workflow.retryOf) as RecoveryWorkflow | undefined;
      if (!ancestor || ancestor.projectId !== current.workflow.projectId || ancestor.namespace !== current.workflow.namespace) {
        throw new HttpError(403, 'Checkpoint source project or namespace mismatch');
      }
      workflow = ancestor;
    }
    if (workflow.projectId !== current.workflow.projectId || workflow.namespace !== current.workflow.namespace) {
      throw new HttpError(403, 'Checkpoint source project or namespace mismatch');
    }
    const spec = workflow.spec.workflow.tasks.find(task => task.name === source.task);
    if (!spec) throw new HttpError(409, 'Checkpoint source task no longer exists');
    return {
      ...current, workflow, spec,
      claims: { ...current.claims, workflowId: source.workflowId, task: source.task, attempt: source.attempt, epoch: source.epoch },
    };
  }

  private async select(source: CheckpointSource, context: AuthContext, index: number, signature: string): Promise<Plan | undefined> {
    const key = checkpointIndexKey(source, index);
    const pointer = await this.deps.repo.kv.get(key.pk, key.sk) as CommittedCheckpointIndex | undefined;
    if (pointer) {
      if (pointer.signature !== signature || !pointer.planKey.startsWith(`RUNTIME#${source.epoch}#UPLOAD#`)) {
        throw new HttpError(409, 'Checkpoint index identity mismatch');
      }
      const plan = await this.deps.repo.kv.get(key.pk, pointer.planKey) as Plan | undefined;
      if (!plan || plan.state !== 'READY' || plan.publicationId !== pointer.publicationId) throw new HttpError(409, 'Checkpoint index is not committed');
      return plan;
    }
    // Upgrade compatibility: old READY publications have no small lookup index.
    // Never silently truncate a legacy history and select an arbitrary snapshot.
    const history = await this.deps.repo.kv.query(key.pk, `RUNTIME#${source.epoch}#UPLOAD#`, { limit: 1001 });
    if (history.length > 1000) throw new HttpError(503, 'Legacy checkpoint history exceeds safe restore selection limit');
    const destination = checkpointURL(context.spec.checkpoint![index], index, {
      workflowId: source.workflowId, task: source.task, projectId: context.workflow.projectId, artifactBucket: this.deps.artifactBucket,
    });
    const prefix = `projects/${context.claims.projectId}/runs/${source.workflowId}/attempts/${source.attempt}/checkpoints/${source.task}/`;
    const candidates = (history as Plan[]).filter(plan => plan.state === 'READY' && plan.receipt &&
      plan.prefix?.startsWith(prefix) && plan.request?.destination === destination);
    candidates.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.publicationId.localeCompare(a.publicationId));
    return candidates[0];
  }

  async plan(token: string, replica: number, signal?: AbortSignal, page?: PlanPage) {
    const current = await this.authenticate(token);
    replicaIndex(current, replica);
    const parsed = z.array(sourceSchema).max(32).safeParse((current.task as RecoveryTask).checkpointRestoreSources ?? []);
    if (!parsed.success) throw new HttpError(409, 'Invalid server checkpoint lineage');
    const root = current.task.outputPath;
    const expected = current.workflow.projectId
      ? `/fsx/checkpoints/projects/${current.workflow.projectId}/runs/${current.workflow.id}/attempts/${current.claims.attempt}/${current.claims.task}`
      : `/fsx/checkpoints/workflows/${current.workflow.id}/${current.claims.task}${current.claims.attempt > 1 ? `/attempts/${current.claims.attempt}` : ''}`;
    if (!root || root !== expected) throw new HttpError(409, 'Checkpoint restore requires the current attempt output root');
    const service = new CheckpointService(this.deps, this.authenticate);
    const checkpoints = [];
    for (const [index, checkpoint] of (current.spec.checkpoint ?? []).entries()) {
      for (const source of parsed.data) {
        signal?.throwIfAborted();
        const context = await this.sourceContext(current, source);
        const previous = context.spec.checkpoint?.[index];
        if (!previous || checkpointSignature(previous) !== checkpointSignature(checkpoint)) {
          throw new HttpError(409, 'Checkpoint declaration changed across retry lineage');
        }
        const selected = await this.select(source, context, index, checkpointSignature(checkpoint));
        if (!selected) continue;
        const verified = await service.readCommitted(context, selected, signal, false);
        if (verified.index !== index) throw new HttpError(409, 'Committed checkpoint slot mismatch');
        await this.authenticate(token);
        checkpoints.push({
          index, path: checkpointPath(checkpoint, { outputPath: root, workflowId: current.workflow.id, task: current.claims.task }),
          destination: posix.join(root, '.pai-resume', `replica-${replica}`, `checkpoint-${index}`, selected.receipt!.manifestHash),
          publicationId: selected.publicationId, manifestHash: selected.receipt!.manifestHash, source,
          files: verified.manifest.objects.map(object => ({ ...object, bucket: verified.bucket })),
        });
        break;
      }
    }
    signal?.throwIfAborted();
    const selected = selectPlanPage(checkpoints, current, this.deps.signingKey, `checkpoints:${replica}`, page);
    const result = [];
    for (const checkpoint of selected.groups) {
      const files = [];
      for (const object of checkpoint.files) {
        signal?.throwIfAborted();
        await service.verifyCommittedObject(object.bucket, object, signal);
        await this.authenticate(token);
        files.push({
          path: object.path, size: object.size, checksumSHA256: object.checksumSHA256,
          checksumType: 'FULL_OBJECT' as const, versionId: object.versionId,
          url: await service.storage.presignGet(object.bucket, object.key, object.versionId, 300),
        });
      }
      result.push({ ...checkpoint, files });
    }
    await this.authenticate(token);
    return { checkpoints: result, ...(selected.nextCursor ? { nextCursor: selected.nextCursor } : {}) };
  }
}
