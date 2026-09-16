import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { HttpError } from '../errors';
import type { Item } from '../store/dynamo';
import type { Write } from '../store/atomic';
import type { BrokerDeps } from './broker';
import { guardChecks, type AuthContext } from './ledger';
import { verifyCapability } from './capability';
import { RUNTIME_LIMITS, multipartLayout } from './limits';
import { objectStorage, type FileDescription } from './storage';
import { safeRelative, validChecksum, type Plan } from './uploads';
import type { StoredPart } from './multipart-storage';
import { activeUploadWrite } from './upload-registry';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const reference = z.object({ publicationId: z.string().regex(/^[a-f0-9]{64}$/), path: z.string().refine(safeRelative) });
const partRequest = reference.extend({ number: z.number().int().min(1).max(10_000), checksumSHA256: z.string().refine(validChecksum) }).strict();
function fail(message: string, status = 409): never { throw new HttpError(status, message); }
export interface UploadFile extends Item {
  id: string; publicationId: string; path: string; key: string;
  mode: 'SINGLE' | 'MULTIPART'; state: 'CREATING' | 'OPEN' | 'COMPLETING' | 'COMPLETE' | 'ABORTED';
  revision: number; size: number; checksumSHA256: string;
  partSize: number; partCount: number; uploadId?: string; composite?: string; versionId?: string;
  storageChecksumSHA256?: string; storageChecksumType?: 'FULL_OBJECT' | 'COMPOSITE';
}
interface UploadFilePlan {
  path: string; mode: 'SINGLE' | 'MULTIPART'; state: UploadFile['state'];
  partSize?: number; partCount?: number; url?: string; headers?: Record<string, string>;
}
interface PartIdentity extends Item { number: number; size: number; checksumSHA256: string }
export const uploadFileKey = (plan: Plan, path: string) => ({ pk: plan.pk, sk: `${plan.sk.replace('#UPLOAD#', '#UPLOAD-FILE#')}#${hash(path)}` });
export class UploadFiles {
  private readonly storage;
  constructor(private readonly deps: BrokerDeps, private readonly authenticate: (token: string) => Promise<AuthContext>,
    private readonly registered: (context: AuthContext, publicationId: string) => Promise<Plan>) {
    this.storage = deps.storage ?? objectStorage;
  }
  private async scope(token: string, payload: unknown) {
    const parsed = reference.strict().safeParse(payload);
    if (!parsed.success) fail('Invalid checkpoint file reference', 400);
    const context = await this.authenticate(token);
    const plan = await this.registered(context, parsed.data.publicationId);
    if (plan.request.protocolVersion !== 2) fail('Checkpoint file endpoints require protocolVersion 2', 400);
    const file = plan.request.files.find(file => file.path === parsed.data.path);
    if (!file) fail('Checkpoint file is outside the registered manifest', 403);
    if (!['PENDING', 'READY'].includes(plan.state)) fail('Checkpoint publication is aborted', 410);
    return { context, plan, file };
  }
  private async lock<T>(row: UploadFile, fn: (current: UploadFile, lease: Item, check: () => Promise<void>) => Promise<T>,
    authenticate: () => Promise<unknown>) {
    const kv = this.deps.repo.kv, holder = randomUUID(), key = { pk: row.pk, sk: `${row.sk}#LOCK` };
    if (!await kv.acquireLease(key.pk, key.sk, holder, 90)) fail('Checkpoint file is busy; retry');
    const lease = { ...key, holder };
    let lost = false, renewal: Promise<unknown> | undefined;
    const timer = setInterval(() => {
      if (!renewal) renewal = kv.acquireLease(key.pk, key.sk, holder, 90)
        .then(ok => { lost ||= !ok; }, () => { lost = true; }).finally(() => { renewal = undefined; });
    }, 25_000);
    timer.unref();
    const check = async () => {
      if (lost) fail('Checkpoint upload lease lost; retry');
      await authenticate();
      const current = await kv.get(key.pk, key.sk);
      if (current?.holder !== holder || Number(current.expires) <= Date.now() / 1000) fail('Checkpoint upload lease expired; retry');
    };
    try {
      await check();
      const current = await kv.get(row.pk, row.sk) as UploadFile | undefined;
      if (!current) fail('Checkpoint file registration disappeared');
      return await fn(current, lease, check);
    } finally {
      clearInterval(timer);
      if (renewal) await renewal;
      await kv.transaction([{ kind: 'delete', ...key, condition: { equals: { holder } } }]);
    }
  }
  private leaseCheck(lease: Item): Write {
    return { kind: 'check', pk: lease.pk, sk: lease.sk, condition: { equals: { holder: lease.holder }, after: { expires: Math.floor(Date.now() / 1000) } } };
  }
  private async change(context: AuthContext, plan: Plan, row: UploadFile, changes: Partial<UploadFile>, lease: Item) {
    const next = { ...row, ...changes, revision: row.revision + 1 };
    if (!await this.deps.repo.kv.transaction([...guardChecks(context), this.leaseCheck(lease),
      { kind: 'check', pk: plan.pk, sk: plan.sk, condition: { equals: { state: 'PENDING' } } },
      { kind: 'put', item: next, condition: { equals: { revision: row.revision, state: row.state } } },
    ])) fail('Checkpoint file changed or publication fenced; retry');
    return next;
  }
  private dto(row: UploadFile) {
    return { path: row.path, mode: row.mode, state: row.state, partSize: row.partSize, partCount: row.partCount };
  }
  private async head(plan: Plan, row: UploadFile) {
    try { return await this.storage.head(plan.bucket, row.key); }
    catch (error) { if (['NotFound', 'NoSuchKey'].includes((error as Error).name)) return; throw error; }
  }
  private async initialize(context: AuthContext, plan: Plan, row: UploadFile, lease: Item, signal?: AbortSignal) {
    if (row.mode !== 'MULTIPART' || row.state !== 'CREATING') return row;
    const storage = this.storage.multipart;
    if (!storage) fail('Multipart checkpoint storage is unavailable', 503);
    const uploads = await storage.uploads(plan.bucket, row.key, signal);
    if (uploads.length > 1) fail('Ambiguous multipart initiation; abort this publication');
    const uploadId = uploads[0] ?? await storage.create(plan.bucket, row.key, row.id, row.checksumSHA256, signal);
    return this.change(context, plan, row, { uploadId, state: 'OPEN' }, lease);
  }
  async file(token: string, payload: unknown, signal?: AbortSignal): Promise<UploadFilePlan> {
    const { context, plan, file } = await this.scope(token, payload);
    if (plan.state === 'READY') return { path: file.path, state: 'COMPLETE', mode: file.size > RUNTIME_LIMITS.singlePutBytes ? 'MULTIPART' : 'SINGLE' };
    const key = uploadFileKey(plan, file.path);
    let row = await this.deps.repo.kv.get(key.pk, key.sk) as UploadFile | undefined;
    if (!row) {
      const mode = file.size > RUNTIME_LIMITS.singlePutBytes ? 'MULTIPART' : 'SINGLE';
      row = { ...key, ...file, id: hash(plan.publicationId + '\n' + file.path), publicationId: plan.publicationId,
        key: plan.prefix + 'objects/' + file.path, mode, state: mode === 'SINGLE' ? 'OPEN' : 'CREATING', revision: 0,
        ttl: Math.floor(this.deps.now().getTime() / 1000) + 9 * 86400,
        ...(mode === 'MULTIPART' ? multipartLayout(file.size) : { partSize: 0, partCount: 0 }) };
      if (!await this.deps.repo.kv.transaction([...guardChecks(context),
        { kind: 'check', pk: plan.pk, sk: plan.sk, condition: { equals: { state: 'PENDING' } } },
        { kind: 'put', item: row, condition: { absent: true } },
      ])) fail('Concurrent checkpoint file registration; retry');
    }
    return this.lock(row, async (current, lease) => {
      current = await this.initialize(context, plan, current, lease, signal);
      if (current.state === 'COMPLETE' || current.mode === 'MULTIPART') return this.dto(current);
      if (current.state !== 'OPEN') fail('Checkpoint file is not open');
      const head = await this.head(plan, current);
      if (head) {
        if (head.size !== file.size || head.checksumSHA256 !== file.checksumSHA256 || head.checksumType === 'COMPOSITE') fail('Single checkpoint object checksum mismatch');
        current = await this.change(context, plan, current, { state: 'COMPLETE', versionId: head.versionId,
          storageChecksumSHA256: head.checksumSHA256, storageChecksumType: 'FULL_OBJECT' }, lease);
        return this.dto(current);
      }
      const signed = await this.storage.presignPut(plan.bucket, current.key, file, 300, true);
      await this.authenticate(token);
      return { ...this.dto(current), ...signed };
    }, () => this.authenticate(token));
  }
  async part(token: string, payload: unknown, signal?: AbortSignal) {
    const parsed = partRequest.safeParse(payload);
    if (!parsed.success) fail('Invalid checkpoint part', 400);
    const request = parsed.data;
    const { context, plan, file } = await this.scope(token, { publicationId: request.publicationId, path: request.path });
    if (plan.state !== 'PENDING') fail('Checkpoint publication is already committed', 410);
    const key = uploadFileKey(plan, file.path);
    const row = await this.deps.repo.kv.get(key.pk, key.sk) as UploadFile | undefined;
    if (!row || row.mode !== 'MULTIPART' || !row.uploadId) fail('Multipart checkpoint file must be initialized');
    return this.lock(row, async (current, lease) => {
      if (current.state !== 'OPEN' || request.number > current.partCount) fail('Checkpoint part is outside the open upload', 400);
      const expected: PartIdentity = { pk: current.pk, sk: `${current.sk}#PART#${String(request.number).padStart(5, '0')}`,
        number: request.number, size: Math.min(current.partSize, current.size - (request.number - 1) * current.partSize),
        checksumSHA256: request.checksumSHA256, ttl: Math.floor(this.deps.now().getTime() / 1000) + 9 * 86400 };
      const old = await this.deps.repo.kv.get(expected.pk, expected.sk) as PartIdentity | undefined;
      if (old && (old.size !== expected.size || old.checksumSHA256 !== expected.checksumSHA256)) fail('Checkpoint part identity changed', 400);
      if (!old && !await this.deps.repo.kv.transaction([...guardChecks(context), this.leaseCheck(lease),
        { kind: 'check', pk: plan.pk, sk: plan.sk, condition: { equals: { state: 'PENDING' } } },
        { kind: 'put', item: expected, condition: { absent: true } },
      ])) fail('Concurrent checkpoint part registration; retry');
      const storage = this.storage.multipart!;
      const parts = await storage.parts(plan.bucket, current.key, current.uploadId!, signal, request.number);
      const existing = parts.find(part => part.number === request.number);
      if (existing && (existing.size !== expected.size || existing.checksumSHA256 !== expected.checksumSHA256)) fail('Stored checkpoint part checksum mismatch');
      await this.authenticate(token);
      if (existing) return { state: 'UPLOADED', number: expected.number };
      const signed = await storage.sign(plan.bucket, current.key, current.uploadId!, expected);
      await this.authenticate(token);
      return { state: 'UPLOAD', number: expected.number, ...signed };
    }, () => this.authenticate(token));
  }
  async complete(token: string, payload: unknown, signal: AbortSignal) {
    const { context, plan, file } = await this.scope(token, payload);
    const key = uploadFileKey(plan, file.path);
    const row = await this.deps.repo.kv.get(key.pk, key.sk) as UploadFile | undefined;
    if (!row) fail('Checkpoint file is not registered');
    if (row.state === 'COMPLETE') return this.dto(row);
    if (row.mode === 'SINGLE') return this.file(token, payload, signal);
    const storage = this.storage.multipart!;
    return this.lock(row, async (current, lease, check) => {
      if (current.state === 'COMPLETE') return this.dto(current);
      if (!['OPEN', 'COMPLETING'].includes(current.state) || !current.uploadId) fail('Multipart checkpoint is not open');
      const uploadId = current.uploadId;
      if (current.state === 'OPEN') {
        const parts = await storage.parts(plan.bucket, current.key, uploadId, signal);
        if (parts.some((part, i) => part.number !== i + 1 ||
          part.size !== Math.min(current.partSize, current.size - i * current.partSize) || !validChecksum(part.checksumSHA256))) {
          fail('Multipart completion has an invalid part sequence');
        }
        const identities = await this.deps.repo.kv.query(current.pk, `${current.sk}#PART#`, { limit: RUNTIME_LIMITS.parts + 1 }) as PartIdentity[];
        parts.sort((a, b) => a.number - b.number);
        identities.sort((a, b) => a.number - b.number);
        if (parts.length !== current.partCount || identities.length !== parts.length) fail('Multipart checkpoint is missing parts');
        for (let i = 0; i < parts.length; i++) {
          const part = parts[i], expected = identities[i];
          if (part.number !== i + 1 || expected.number !== part.number || !validChecksum(part.checksumSHA256) ||
            part.checksumSHA256 !== expected.checksumSHA256 || part.size !== expected.size ||
            part.size !== Math.min(current.partSize, current.size - i * current.partSize)) fail('Multipart checkpoint part verification failed');
        }
        const composite = createHash('sha256').update(Buffer.concat(parts.map(part => Buffer.from(part.checksumSHA256, 'base64')))).digest('base64') + '-' + parts.length;
        current = await this.change(context, plan, current, { state: 'COMPLETING', composite }, lease);
      }
      let head = await this.head(plan, current);
      if (!head) {
        const parts = await storage.parts(plan.bucket, current.key, uploadId, signal);
        parts.sort((a, b) => a.number - b.number);
        if (parts.some((part, i) => part.number !== i + 1 ||
          part.size !== Math.min(current.partSize, current.size - i * current.partSize) || !validChecksum(part.checksumSHA256))) {
          fail('Multipart completion has an invalid part sequence');
        }
        const composite = createHash('sha256').update(Buffer.concat(parts.sort((a, b) => a.number - b.number)
          .map(part => Buffer.from(part.checksumSHA256, 'base64')))).digest('base64') + '-' + parts.length;
        if (parts.length !== current.partCount || composite !== current.composite) fail('Multipart parts changed after completion was requested');
        try { await storage.complete(plan.bucket, current.key, uploadId, parts, current.composite!, signal); }
        catch (error) {
          signal.throwIfAborted();
          head = await this.head(plan, current);
          if (!head) throw error; // Retain COMPLETING. A later retry reconciles the actual object.
        }
        head ??= await this.head(plan, current);
      }
      if (!head || !head.versionId || head.versionId === 'null' || head.size !== current.size ||
        head.checksumType !== 'COMPOSITE' || head.checksumSHA256 !== current.composite ||
        head.metadata?.['pai-checkpoint-file'] !== current.id || head.metadata?.['pai-full-sha256'] !== current.checksumSHA256) {
        fail('Completed multipart checkpoint identity mismatch');
      }
      await check();
      const digest = await storage.sha256(plan.bucket, current.key, head.versionId, current.size, signal, async () => {
        await check();
        const active = await this.deps.repo.kv.get(plan.pk, plan.sk);
        if (active?.state !== 'PENDING') fail('Checkpoint publication was aborted', 410);
      });
      if (digest !== current.checksumSHA256) fail('Multipart checkpoint full-file SHA256 mismatch', 422);
      await check();
      const fresh = await this.authenticate(token);
      current = await this.change(fresh, plan, current, { state: 'COMPLETE', versionId: head.versionId,
        storageChecksumSHA256: head.checksumSHA256, storageChecksumType: 'COMPOSITE' }, lease);
      return this.dto(current);
    }, () => this.authenticate(token));
  }
  /** Signed scope authorizes cleanup even after fencing; never publication or READY deletion. */
  async abort(token: string, payload: unknown, signal?: AbortSignal) {
    const claims = verifyCapability(token, this.deps.signingKey, this.deps.now());
    const parsed = z.object({ publicationId: z.string().regex(/^[a-f0-9]{64}$/) }).strict().safeParse(payload);
    if (!parsed.success) fail('Invalid checkpoint abort reference', 400);
    return this.cleanup(claims.workflowId, claims.epoch, parsed.data.publicationId, claims.projectId, claims.task, claims.attempt, signal);
  }
  async cleanup(workflowId: string, epoch: string, publicationId: string, projectId: string, task: string, attempt: number, signal?: AbortSignal) {
    const pk = `WF#${workflowId}`, sk = `RUNTIME#${epoch}#UPLOAD#${publicationId}`;
    let plan = await this.deps.repo.kv.get(pk, sk) as Plan | undefined;
    if (!plan) return { state: 'ABORTED', clean: true };
    if (plan.publicationId !== publicationId || plan.prefix !== `projects/${projectId}/runs/${workflowId}/attempts/${attempt}/checkpoints/${task}/${publicationId}/` ||
      plan.bucket !== this.deps.artifactBucket) fail('Checkpoint cleanup scope mismatch', 403);
    if (plan.state === 'READY') {
      const writes = await activeUploadWrite(this.deps, plan, false);
      if (writes.length && !await this.deps.repo.kv.transaction(writes)) fail('Checkpoint registry changed; retry');
      return { state: 'READY', clean: true };
    }
    if (plan.state === 'PENDING') {
      if (!await this.deps.repo.kv.transaction([{ kind: 'put', item: { ...plan, state: 'ABORTING' },
        condition: { equals: { state: 'PENDING' } } }])) fail('Checkpoint publication changed during abort; retry');
      plan = { ...plan, state: 'ABORTING' };
    }
    const storage = this.storage.multipart;
    if (!storage) fail('Checkpoint cleanup storage unavailable', 503);
    for (const file of plan.request.files) {
      signal?.throwIfAborted();
      const key = uploadFileKey(plan, file.path);
      let row = await this.deps.repo.kv.get(key.pk, key.sk) as UploadFile | undefined;
      if (!row) {
        // Part/session metadata has a TTL. The immutable request still supplies
        // enough identity for operator cleanup after that metadata expires.
        const mode = file.size > RUNTIME_LIMITS.singlePutBytes ? 'MULTIPART' : 'SINGLE';
        row = { ...key, ...file, id: hash(publicationId + '\n' + file.path), publicationId,
          key: plan.prefix + 'objects/' + file.path, mode, state: 'ABORTED', revision: 0,
          ...(mode === 'MULTIPART' ? multipartLayout(file.size) : { partSize: 0, partCount: 0 }) };
        if (!await this.deps.repo.kv.transaction([
          { kind: 'check', pk, sk, condition: { equals: { state: plan.state } } },
          { kind: 'put', item: row, condition: { absent: true } },
        ])) fail('Checkpoint cleanup registration changed; retry');
      }
      await this.lock(row, async current => {
        for (const id of await storage.uploads(plan!.bucket, current.key, signal)) await storage.abort(plan!.bucket, current.key, id, signal);
        if ((await storage.uploads(plan!.bucket, current.key, signal)).length) fail('Multipart abort is still settling; retry');
        const head = await this.head(plan!, current);
        if (head) {
          if (current.mode === 'MULTIPART' && head.metadata?.['pai-checkpoint-file'] !== current.id) fail('Refusing to delete unrelated checkpoint object');
          if (current.mode === 'SINGLE' && (head.checksumSHA256 !== current.checksumSHA256 || head.size !== current.size)) fail('Refusing to delete unrelated checkpoint object');
          await storage.deleteVersion(plan!.bucket, current.key, head.versionId, signal);
        }
        if (!await this.deps.repo.kv.transaction([
          { kind: 'check', pk, sk, condition: { equals: { state: plan!.state } } },
          { kind: 'put', item: { ...current, state: 'ABORTED', revision: current.revision + 1 },
            condition: { equals: { state: current.state, revision: current.revision } } },
        ])) fail('Checkpoint cleanup state changed; retry');
      }, async () => {
        const active = await this.deps.repo.kv.get(pk, sk);
        if (active?.state === 'READY') fail('Committed checkpoint cannot be aborted', 403);
      });
    }
    const manifest = await this.storage.readManifest(plan.bucket, plan.prefix + 'manifest.json', signal);
    if (manifest) {
      let identity: { publicationId?: string };
      try { identity = JSON.parse(manifest.body); } catch { fail('Cannot clean malformed checkpoint manifest'); }
      if (identity.publicationId !== publicationId) fail('Refusing to delete unrelated checkpoint manifest');
      await storage.deleteVersion(plan.bucket, plan.prefix + 'manifest.json', manifest.versionId, signal);
    }
    if (!await this.deps.repo.kv.transaction([{ kind: 'put', item: { ...plan, state: 'ABORTED' },
      condition: { equals: { state: plan.state } } }, ...await activeUploadWrite(this.deps, plan, false)])) fail('Checkpoint abort changed; retry');
    return { state: 'ABORTED', clean: true };
  }
}
