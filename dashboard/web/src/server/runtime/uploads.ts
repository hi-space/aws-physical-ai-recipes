import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { z } from 'zod';
import { HttpError } from '../errors';
import type { Item } from '../store/dynamo';
import type { BrokerDeps } from './broker';
import { guardChecks, type AuthContext } from './ledger';
import { objectStorage, type FileDescription, type ObjectStorage } from './storage';
import { checkpointSignature, checkpointURL, type CheckpointSource } from '../workflow/checkpoints';
import type { Write } from '../store/atomic';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export function safeRelative(path: string): boolean {
  return !!path && path.length <= 1024 && !path.startsWith('/') && !/[\\%\x00-\x1f\x7f]/.test(path) && path.split('/').every(part => part !== '' && part !== '.' && part !== '..') && posix.normalize(path) === path;
}
export function validChecksum(checksum: string): boolean {
  return /^[A-Za-z0-9+/]{43}=$/.test(checksum) && Buffer.from(checksum, 'base64').length === 32 && Buffer.from(checksum, 'base64').toString('base64') === checksum;
}
const requestSchema = z.object({
  purpose: z.literal('checkpoint'),
  destination: z.string().max(2048),
  files: z.array(z.object({
    path: z.string().refine(safeRelative),
    size: z.number().int().min(0).max(5 * 1024 ** 3),
    checksumSHA256: z.string().refine(validChecksum)
  }).strict()).min(1).max(1024)
}).strict();
type UploadRequest = z.infer<typeof requestSchema>;
export interface Plan extends Item {
  publicationId: string;
  prefix: string;
  bucket: string;
  request: UploadRequest;
  createdAt: string;
  state: 'PENDING' | 'READY';
  receipt?: CheckpointReceipt;
  checkpointIndex?: number;
  checkpointSignature?: string;
}
export interface CommittedCheckpointIndex extends Item {
  publicationId: string;
  planKey: string;
  createdAt: string;
  signature: string;
}
export const checkpointIndexKey = (source: CheckpointSource, index: number) => ({
  pk: `WF#${source.workflowId}`, sk: `RUNTIME#${source.epoch}#CHECKPOINT#${source.task}#${index}`,
});
export interface CheckpointReceipt {
  state: 'READY';
  publicationId: string;
  manifestUri: string;
  manifestVersionId: string;
  manifestHash: string;
  verifiedAt: string;
  objectCount: number;
  sizeBytes: number;
}
export interface CheckpointManifest {
  publicationId: string;
  workflowId: string;
  projectId: string;
  task: string;
  epoch: string;
  attempt: number;
  destination: string;
  createdAt: string;
  objects: (FileDescription & {
    key: string;
    versionId: string;
  })[];
}
export class CheckpointService {
  readonly storage: ObjectStorage;
  constructor(private readonly deps: BrokerDeps, private readonly authenticate: (token: string) => Promise<AuthContext>) {
    this.storage = deps.storage ?? objectStorage;
  }
  private prepare(context: AuthContext, payload: unknown) {
    const parsed = requestSchema.safeParse(payload);
    if (!parsed.success) throw new HttpError(400, 'Invalid checkpoint file manifest');
    const request = parsed.data;
    request.files.sort((a, b) => a.path.localeCompare(b.path));
    if (new Set(request.files.map(file => file.path)).size !== request.files.length) throw new HttpError(400, 'Duplicate checkpoint paths');
    if (Buffer.byteLength(JSON.stringify(request)) > 300_000) throw new HttpError(400, 'Checkpoint plan exceeds durable metadata size limit');
    const bucket = this.deps.artifactBucket;
    if (!bucket) throw new HttpError(503, 'Checkpoint artifact bucket is not configured');
    let uri: URL;
    try {
      uri = new URL(request.destination);
    } catch {
      throw new HttpError(400, 'Invalid checkpoint destination');
    }
    if (uri.protocol !== 's3:' || uri.username || uri.password || uri.search || uri.hash || uri.port || !safeRelative(uri.pathname.slice(1).replace(/\/$/, ''))) throw new HttpError(400, 'Invalid checkpoint destination');
    const matching = (context.spec.checkpoint ?? []).flatMap((cp, index) => checkpointURL(cp, index, {
      workflowId: context.claims.workflowId, task: context.claims.task, projectId: context.workflow.projectId, artifactBucket: bucket,
    }) === request.destination ? [index] : []);
    if (uri.hostname !== bucket || !uri.pathname.startsWith(`/projects/${context.claims.projectId}/`) || matching.length !== 1) throw new HttpError(403, 'Checkpoint destination is not authorized for this task');
    const c = context.claims;
    const publicationId = hash(JSON.stringify({
      workflowId: c.workflowId,
      projectId: c.projectId,
      namespace: c.namespace,
      task: c.task,
      epoch: c.epoch,
      attempt: c.attempt,
      request
    }));
    const prefix = `projects/${c.projectId}/runs/${c.workflowId}/attempts/${c.attempt}/checkpoints/${c.task}/${publicationId}/`;
    return {
      request,
      bucket,
      prefix,
      publicationId,
      checkpointIndex: matching[0],
      checkpointSignature: checkpointSignature(context.spec.checkpoint![matching[0]]),
      key: {
        pk: `WF#${c.workflowId}`,
        sk: `RUNTIME#${c.epoch}#UPLOAD#${publicationId}`
      }
    };
  }
  async plan(token: string, payload: unknown) {
    const context = await this.authenticate(token),
      p = this.prepare(context, payload);
    const old = (await this.deps.repo.kv.get(p.key.pk, p.key.sk)) as Plan | undefined;
    if (!old) {
      const plan: Plan = {
        ...p.key,
        request: p.request,
        publicationId: p.publicationId,
        prefix: p.prefix,
        bucket: p.bucket,
        state: 'PENDING',
        checkpointIndex: p.checkpointIndex,
        checkpointSignature: p.checkpointSignature,
        createdAt: this.deps.now().toISOString()
      };
      if (!(await this.deps.repo.kv.transaction([...guardChecks(context), {
        kind: 'put',
        item: plan,
        condition: {
          absent: true
        }
      }]))) {
        await this.authenticate(token);
        if (!(await this.deps.repo.kv.get(p.key.pk, p.key.sk))) throw new HttpError(409, 'Concurrent upload registration; retry');
      }
    }
    const uploads = [];
    for (const file of p.request.files) {
      const signed = await this.storage.presignPut(p.bucket, p.prefix + 'objects/' + file.path, file, 300);
      uploads.push({
        path: file.path,
        ...signed
      });
    }
    await this.authenticate(token);
    return {
      uploads
    };
  }
  private parseManifest(body: string, context: AuthContext, p: ReturnType<CheckpointService['prepare']>): CheckpointManifest {
    let manifest: CheckpointManifest;
    try {
      manifest = JSON.parse(body);
    } catch {
      throw new HttpError(409, 'Checkpoint manifest is invalid');
    }
    const c = context.claims;
    if (manifest.publicationId !== p.publicationId || manifest.workflowId !== c.workflowId || manifest.epoch !== c.epoch || manifest.attempt !== c.attempt || manifest.projectId !== c.projectId || manifest.task !== c.task || manifest.destination !== p.request.destination || !Array.isArray(manifest.objects) || manifest.objects.length !== p.request.files.length) throw new HttpError(409, 'Checkpoint manifest identity mismatch');
    for (const [index, file] of p.request.files.entries()) {
      const object = manifest.objects[index];
      if (object.path !== file.path || object.size !== file.size || object.checksumSHA256 !== file.checksumSHA256 || object.key !== p.prefix + 'objects/' + file.path || !object.versionId || object.versionId === 'null') throw new HttpError(409, 'Checkpoint manifest object mismatch');
    }
    return manifest;
  }
  private async indexWrite(context: AuthContext, p: ReturnType<CheckpointService['prepare']>, plan: Plan): Promise<Write[]> {
    const key = checkpointIndexKey({
      workflowId: context.claims.workflowId, task: context.claims.task,
      attempt: context.claims.attempt, epoch: context.claims.epoch,
    }, p.checkpointIndex);
    const old = await this.deps.repo.kv.get(key.pk, key.sk) as CommittedCheckpointIndex | undefined;
    if (old && (old.createdAt > plan.createdAt || old.createdAt === plan.createdAt && old.publicationId >= p.publicationId)) return [];
    return [{ kind: 'put', item: {
      ...key, publicationId: p.publicationId, planKey: p.key.sk, createdAt: plan.createdAt, signature: p.checkpointSignature,
    }, condition: old ? { equals: { publicationId: old.publicationId, createdAt: old.createdAt } } : { absent: true } }];
  }

  /** Read-only verification uses source identities, never a source capability. */
  async readCommitted(context: AuthContext, plan: Plan, signal?: AbortSignal): Promise<{ manifest: CheckpointManifest; bucket: string; index: number }> {
    const p = this.prepare(context, plan.request);
    const receipt = plan.receipt;
    if (plan.state !== 'READY' || !receipt || plan.pk !== p.key.pk || plan.sk !== p.key.sk ||
      plan.publicationId !== p.publicationId || plan.prefix !== p.prefix || plan.bucket !== p.bucket ||
      receipt.state !== 'READY' || receipt.publicationId !== p.publicationId ||
      receipt.manifestUri !== `s3://${p.bucket}/${p.prefix}manifest.json` ||
      !receipt.manifestVersionId || receipt.manifestVersionId === 'null' || !/^[a-f0-9]{64}$/.test(receipt.manifestHash)) {
      throw new HttpError(409, 'Checkpoint does not have a valid committed receipt');
    }
    const stored = await this.storage.readManifest(p.bucket, p.prefix + 'manifest.json', signal, receipt.manifestVersionId);
    if (!stored || stored.versionId !== receipt.manifestVersionId || hash(stored.body) !== receipt.manifestHash) {
      throw new HttpError(409, 'Committed checkpoint manifest version or digest mismatch');
    }
    const manifest = this.parseManifest(stored.body, context, p);
    if (manifest.createdAt !== plan.createdAt || receipt.objectCount !== manifest.objects.length ||
      receipt.sizeBytes !== manifest.objects.reduce((sum, object) => sum + object.size, 0)) {
      throw new HttpError(409, 'Committed checkpoint metadata mismatch');
    }
    for (let offset = 0; offset < manifest.objects.length; offset += 8) {
      signal?.throwIfAborted();
      await Promise.all(manifest.objects.slice(offset, offset + 8).map(async object => {
        const head = await this.storage.head(p.bucket, object.key, object.versionId, signal);
        if (head.versionId !== object.versionId || head.size !== object.size || head.checksumSHA256 !== object.checksumSHA256 ||
          (head.checksumType ?? 'FULL_OBJECT') !== 'FULL_OBJECT') throw new HttpError(409, 'Committed checkpoint object version or checksum mismatch');
      }));
    }
    return { manifest, bucket: p.bucket, index: p.checkpointIndex };
  }
  async complete(token: string, payload: unknown, signal?: AbortSignal): Promise<CheckpointReceipt> {
    let context = await this.authenticate(token);
    const p = this.prepare(context, payload),
      plan = (await this.deps.repo.kv.get(p.key.pk, p.key.sk)) as Plan | undefined;
    if (!plan) throw new HttpError(409, 'Checkpoint upload plan has not been registered');
    if (plan.state === 'READY' && plan.receipt) {
      const writes = await this.indexWrite(context, p, plan);
      if (writes.length && !await this.deps.repo.kv.transaction([...guardChecks(context), ...writes])) {
        await this.authenticate(token); throw new HttpError(409, 'Checkpoint index changed; retry');
      }
      await this.authenticate(token);
      return plan.receipt;
    }
    let stored = await this.storage.readManifest(p.bucket, p.prefix + 'manifest.json', signal);
    let manifest: CheckpointManifest;
    if (stored) manifest = this.parseManifest(stored.body, context, p);else {
      const objects: CheckpointManifest['objects'] = [];
      for (const file of p.request.files) {
        const key = p.prefix + 'objects/' + file.path;
        const head = await this.storage.head(p.bucket, key, undefined, signal);
        if ((head.checksumType ?? 'FULL_OBJECT') !== 'FULL_OBJECT' || head.size !== file.size || head.checksumSHA256 !== file.checksumSHA256 || !head.versionId || head.versionId === 'null') throw new HttpError(409, 'Checkpoint object verification failed');
        objects.push({
          ...file,
          key,
          versionId: head.versionId
        });
      }
      context = await this.authenticate(token);
      signal?.throwIfAborted();
      manifest = {
        publicationId: p.publicationId,
        workflowId: context.claims.workflowId,
        projectId: context.claims.projectId,
        task: context.claims.task,
        epoch: context.claims.epoch,
        attempt: context.claims.attempt,
        destination: p.request.destination,
        createdAt: plan.createdAt,
        objects
      };
      stored = await this.storage.writeManifest(p.bucket, p.prefix + 'manifest.json', JSON.stringify(manifest), signal);
      manifest = this.parseManifest(stored.body, context, p);
    }
    // Pin and verify the manifest's actual versions, including adoption after a lost write reply.
    for (const object of manifest.objects) {
      const head = await this.storage.head(p.bucket, object.key, object.versionId, signal);
      if ((head.checksumType ?? 'FULL_OBJECT') !== 'FULL_OBJECT' || head.versionId !== object.versionId || head.size !== object.size || head.checksumSHA256 !== object.checksumSHA256) throw new HttpError(409, 'Immutable checkpoint version verification failed');
    }
    context = await this.authenticate(token);
    signal?.throwIfAborted();
    const receipt: CheckpointReceipt = {
      state: 'READY',
      publicationId: p.publicationId,
      manifestUri: `s3://${p.bucket}/${p.prefix}manifest.json`,
      manifestVersionId: stored.versionId,
      manifestHash: hash(stored.body),
      verifiedAt: this.deps.now().toISOString(),
      objectCount: manifest.objects.length,
      sizeBytes: manifest.objects.reduce((n, file) => n + file.size, 0)
    };
    const indexWrites = await this.indexWrite(context, p, plan);
    const ok = await this.deps.repo.kv.transaction([...guardChecks(context), {
      kind: 'put',
      item: {
        ...plan,
        state: 'READY',
        receipt
      },
      condition: {
        equals: {
          state: 'PENDING'
        }
      }
    }, ...indexWrites]);
    if (!ok) {
      await this.authenticate(token);
      const saved = (await this.deps.repo.kv.get(p.key.pk, p.key.sk)) as Plan | undefined;
      if (saved?.state === 'READY' && saved.receipt) return saved.receipt;
      throw new HttpError(409, 'Concurrent checkpoint publication; retry');
    }
    return receipt;
  }
}
