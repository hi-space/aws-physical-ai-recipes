import { createHash, randomUUID } from 'node:crypto';
import { CreateMultipartUploadCommand, ListMultipartUploadsCommand, ListPartsCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand, HeadObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { s3 } from '../aws/clients';
import { getRepo, type Repo } from '../store/repo';
import { canReadResource, resolveProject } from '../auth/projects';
import { assertOwner, requireRole, type Session } from '../auth/session';
import { HttpError } from '../errors';
import type { Item } from '../store/dynamo';
const error = (status: number, message: string) => new HttpError(status, message, 'multipart_upload');
const guardKey = (name: string, version: number) => ({ pk: `DS#${name}`, sk: `UPLOAD-GUARD#${version}` });
const versionKey = (name: string, version: number) => ({ pk: `DS#${name}`, sk: `V#${String(version).padStart(6, '0')}` });
const checksum = (value: string) => /^[A-Za-z0-9+/]{43}=$/.test(value) && Buffer.from(value, 'base64').toString('base64') === value;
const terminal = (state: string) => state === 'COMPLETED' || state === 'ABORTED';
interface Guard extends Item {
  revision: number;
  open: number;
  state: 'OPEN' | 'FROZEN';
}
export interface MultipartSession extends Item {
  id: string;
  dataset: string;
  version: number;
  filename: string;
  bucket: string;
  key: string;
  size: number;
  lastModified: number;
  contentType: string;
  partSize: number;
  partCount: number;
  revision: number;
  state: string;
  uploadId?: string;
  composite?: string;
  versionId?: string;
}
interface Deps {
  repo: Repo;
  client: Pick<S3Client, 'send'>;
  bucket: string;
  sign(command: UploadPartCommand): Promise<string>;
}
function guard(repo: Repo, name: string, version: number) {
  return repo.kv.get(guardKey(name, version).pk, guardKey(name, version).sk) as Promise<Guard | undefined>;
}
function openGuard(name: string, version: number): Guard {
  return { ...guardKey(name, version), revision: 0, open: 0, state: 'OPEN' };
}
export async function freezeVersionUploads(name: string, version: number, repo = getRepo()) {
  for (let i = 0; i < 10; i++) {
    const old = await guard(repo, name, version);
    if (old?.open) throw error(409, 'Complete or abort unfinished multipart uploads first');
    if (old?.state === 'FROZEN') return;
    if (await repo.kv.transaction([{
      kind: 'put',
      item: { ...(old ?? openGuard(name, version)), state: 'FROZEN', revision: (old?.revision ?? 0) + 1 },
      condition: old ? { equals: { revision: old.revision, state: 'OPEN' } } : { absent: true }
    }])) return;
  }
  throw error(409, 'Upload registrations changed; retry finalization');
}
export async function reopenVersionUploads(name: string, version: number, repo = getRepo()) {
  if ((await repo.getVersion(name, version))?.state !== 'PENDING') return;
  const old = await guard(repo, name, version);
  if (old?.state === 'FROZEN') await repo.kv.transaction([{ kind: 'put', item: { ...old, state: 'OPEN', revision: old.revision + 1 }, condition: { equals: { revision: old.revision, state: 'FROZEN' } } }]);
}
/** Legacy PUT registration shares filename ownership and the finalization barrier. */
export async function registerSingleUpload(name: string, version: number, filename: string, bucket: string, key: string, repo = getRepo()) {
  const g = await guard(repo, name, version),
    slot = { pk: `DS#${name}`, sk: `UPLOAD#${version}#${filename}` },
    old = await repo.kv.get(slot.pk, slot.sk);
  if (g?.state === 'FROZEN' || old?.mode === 'MULTIPART') throw error(409, 'Filename is reserved or version finalization has started');
  if (!(await repo.kv.transaction([{ kind: 'check', ...versionKey(name, version), condition: { equals: { state: 'PENDING' } } }, {
    kind: 'put',
    item: { ...(g ?? openGuard(name, version)), revision: (g?.revision ?? 0) + 1 },
    condition: g ? { equals: { revision: g.revision, state: 'OPEN' } } : { absent: true }
  }, {
    kind: 'put',
    item: { ...slot, bucket, key, version, dataset: name, mode: 'SINGLE' },
    condition: old ? { equals: old.mode ? { mode: 'SINGLE' } : { key: old.key, bucket: old.bucket } } : { absent: true }
  }]))) throw error(409, 'Upload registration changed; retry');
}
export class MultipartUploads {
  constructor(readonly deps: Deps = {
    repo: getRepo(),
    client: s3(),
    bucket: process.env.DASHBOARD_ARTIFACT_BUCKET ?? '',
    sign: command => getSignedUrl(s3(), command, { expiresIn: 900, unhoistableHeaders: new Set(['x-amz-checksum-sha256']) })
  }) {}
  private async scope(user: Session, name: string, version: number) {
    requireRole(user, 'researcher');
    if (!Number.isSafeInteger(version) || version < 1) throw error(400, 'Invalid version');
    const ds = await this.deps.repo.getDataset(name);
    if (!ds || !(await canReadResource(user, ds, this.deps.repo))) throw error(404, 'Dataset not found');
    if (ds.projectId) await resolveProject(user, ds.projectId, this.deps.repo, 'researcher');
    if (!ds.ownerSubject || ds.ownerSubject !== user.subject) assertOwner(user, ds.owner, 'dataset');
    const v = (await this.deps.repo.getVersion(name, version)) as (Awaited<ReturnType<Repo['getVersion']>> & {
      imported?: boolean;
    });
    if (!v || v.state !== 'PENDING' || v.imported) throw error(409, 'Only pending non-imported versions accept uploads');
    const uri = new URL(v.uri);
    if (uri.protocol !== 's3:' || uri.hostname !== this.deps.bucket || !uri.pathname.startsWith(`/projects/${ds.projectId ?? 'legacy'}/datasets/${name}/uploads/`) || !uri.pathname.endsWith('/')) throw error(409, 'Version has no managed upload prefix');
    return { bucket: uri.hostname, prefix: uri.pathname.slice(1), uri: v.uri };
  }
  private dto(r: MultipartSession) {
    const {
      id,
      filename,
      size,
      lastModified,
      partSize,
      partCount,
      state
    } = r;
    return { id, filename, size, lastModified, partSize, partCount, state };
  }
  private async row(name: string, version: number, id: string) {
    const link = await this.deps.repo.kv.get(`DS#${name}`, `MULTIPART#${version}#${id}`);
    const r = link ? (await this.deps.repo.kv.get(`DS#${name}`, `UPLOAD#${version}#${link.filename}`)) as MultipartSession | undefined : undefined;
    if (!r || r.id !== id) throw error(404, 'Upload not found');
    return r;
  }
  private async locked<T>(r: MultipartSession, fn: (row: MultipartSession, lease: Item) => Promise<T>): Promise<T> {
    const lease = { pk: r.pk, sk: `MULTIPART-LOCK#${r.id}`, holder: randomUUID() };
    const kv = this.deps.repo.kv;
    if (!(await kv.acquireLease(lease.pk, lease.sk, lease.holder, 90))) throw error(409, 'Upload is busy; retry shortly');
    let lost = false,
      renewing = false;
    const timer = setInterval(() => {
      if (!renewing) {
        renewing = true;
        void kv.acquireLease(lease.pk, lease.sk, lease.holder, 90).then(ok => {
          lost ||= !ok;
        }, () => {
          lost = true;
        }).finally(() => {
          renewing = false;
        });
      }
    }, 25_000);
    try {
      const result = await fn(await this.row(r.dataset, r.version, r.id), lease);
      if (lost) throw error(409, 'Upload lease lost; resume');
      return result;
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw error(503, 'Multipart storage operation failed; retry or resume');
    } finally {
      clearInterval(timer);
      await kv.transaction([{ kind: 'delete', pk: lease.pk, sk: lease.sk, condition: { equals: { holder: lease.holder } } }]);
    }
  }
  private async change(r: MultipartSession, changes: Partial<MultipartSession>, lease: Item) {
    const g = await guard(this.deps.repo, r.dataset, r.version);
    if (!g || g.state !== 'OPEN') throw error(409, 'Version finalization has started');
    const next = { ...r, ...changes, revision: r.revision + 1 };
    const decrement = !terminal(r.state) && terminal(next.state) ? 1 : 0;
    if (!(await this.deps.repo.kv.transaction([{ kind: 'check', pk: lease.pk, sk: lease.sk, condition: { equals: { holder: lease.holder }, after: { expires: Math.floor(Date.now() / 1000) } } }, { kind: 'check', ...versionKey(r.dataset, r.version), condition: { equals: { state: 'PENDING' } } }, { kind: 'put', item: next, condition: { equals: { id: r.id, revision: r.revision } } }, { kind: 'put', item: { ...g, open: g.open - decrement, revision: g.revision + 1 }, condition: { equals: { revision: g.revision, state: 'OPEN' } } }]))) throw error(409, 'Upload changed; retry');
    return next;
  }
  private async initiations(r: MultipartSession) {
    const matches: string[] = [];
    let KeyMarker: string | undefined, UploadIdMarker: string | undefined;
    do {
      const page = await this.deps.client.send(new ListMultipartUploadsCommand({ Bucket: r.bucket, Prefix: r.key, KeyMarker, UploadIdMarker }), { abortSignal: AbortSignal.timeout(60_000) });
      matches.push(...(page.Uploads ?? []).filter(u => u.Key === r.key && u.UploadId).map(u => u.UploadId!));
      KeyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
      UploadIdMarker = page.NextUploadIdMarker;
    } while (KeyMarker);
    return matches;
  }
  private async initialize(r: MultipartSession, lease: Item) {
    if (r.state !== 'CREATING') return r;
    const matches = await this.initiations(r);
    if (matches.length > 1) throw error(409, 'Ambiguous multipart initiation; abort this session before retrying');
    const uploadId = matches[0] ?? (await this.deps.client.send(new CreateMultipartUploadCommand({ Bucket: r.bucket, Key: r.key, ContentType: r.contentType, ChecksumAlgorithm: 'SHA256', ChecksumType: 'COMPOSITE', Metadata: { 'pai-upload': r.id } }), { abortSignal: AbortSignal.timeout(60_000) })).UploadId;
    if (!uploadId) throw error(503, 'S3 did not return an upload identifier');
    return this.change(r, { uploadId, state: 'UPLOADING' }, lease);
  }
  async start(user: Session, name: string, version: number, input: {
    filename: string;
    size: number;
    lastModified: number;
    contentType?: string;
  }) {
    const scope = await this.scope(user, name, version),
      {
        filename,
        size,
        lastModified
      } = input;
    if (!filename || filename.length > 512 || Buffer.byteLength(scope.prefix + filename) > 1024 || /[\\%\x00-\x1f]/.test(filename) || filename.split('/').some(p => !p || p === '.' || p === '..' || ['manifest.json', '.dataset.json'].includes(p.toLowerCase()) || p.startsWith('.pai-input-')) || !Number.isSafeInteger(size) || size < 1 || size > 1024 ** 4 || !Number.isSafeInteger(lastModified) || lastModified < 0) throw error(400, 'Invalid filename, size, or file identity');
    const slot = { pk: `DS#${name}`, sk: `UPLOAD#${version}#${filename}` };
    let r = (await this.deps.repo.kv.get(slot.pk, slot.sk)) as MultipartSession | undefined;
    if (r && r.state !== 'ABORTED') {
      if (r.mode !== 'MULTIPART' || r.size !== size || r.lastModified !== lastModified) throw error(409, 'Filename is already registered for another file');
    } else {
      const old = r,
        g = await guard(this.deps.repo, name, version);
      if (g?.state === 'FROZEN') throw error(409, 'Version finalization has started');
      const partSize = Math.max(8 * 1024 ** 2, Math.ceil(size / 10000 / 1024 ** 2) * 1024 ** 2),
        id = randomUUID();
      r = {
        ...slot,
        id,
        mode: 'MULTIPART',
        dataset: name,
        version,
        filename,
        bucket: scope.bucket,
        key: scope.prefix + filename,
        size,
        lastModified,
        contentType: input.contentType ?? 'application/octet-stream',
        partSize,
        partCount: Math.ceil(size / partSize),
        revision: 0,
        state: 'CREATING'
      };
      if (!(await this.deps.repo.kv.transaction([{ kind: 'check', ...versionKey(name, version), condition: { equals: { state: 'PENDING', uri: scope.uri } } }, { kind: 'put', item: r, condition: old ? { equals: { id: old.id, state: 'ABORTED' } } : { absent: true } }, { kind: 'put', item: { pk: slot.pk, sk: `MULTIPART#${version}#${id}`, filename }, condition: { absent: true } }, {
        kind: 'put',
        item: { ...(g ?? openGuard(name, version)), open: (g?.open ?? 0) + 1, revision: (g?.revision ?? 0) + 1 },
        condition: g ? { equals: { revision: g.revision, state: 'OPEN' } } : { absent: true }
      }]))) throw error(409, 'Upload registration changed; retry');
    }
    return this.locked(r, async (row, lease) => this.dto(await this.initialize(row, lease)));
  }
  private async parts(r: MultipartSession) {
    const result: {
      number: number;
      size: number;
      etag: string;
      checksum: string;
    }[] = [];
    let marker: number | undefined;
    do {
      const page = await this.deps.client.send(new ListPartsCommand({ Bucket: r.bucket, Key: r.key, UploadId: r.uploadId, PartNumberMarker: marker === undefined ? undefined : String(marker) }), { abortSignal: AbortSignal.timeout(60_000) });
      result.push(...(page.Parts ?? []).map(p => ({ number: p.PartNumber!, size: p.Size!, etag: p.ETag!, checksum: p.ChecksumSHA256! })));
      const next = page.IsTruncated ? Number(page.NextPartNumberMarker) : undefined;
      if (next !== undefined && (!Number.isSafeInteger(next) || next <= (marker ?? 0))) throw error(503, 'Invalid S3 parts cursor');
      marker = next;
    } while (marker !== undefined);
    if (result.length > r.partCount) throw error(409, 'Unexpected S3 parts');
    return result.sort((a, b) => a.number - b.number);
  }
  async list(user: Session, name: string, version: number) {
    await this.scope(user, name, version);
    return (await this.deps.repo.kv.query(`DS#${name}`, `UPLOAD#${version}#`)).filter(r => r.mode === 'MULTIPART').map(r => this.dto(r as MultipartSession));
  }
  async status(user: Session, name: string, version: number, id: string) {
    await this.scope(user, name, version);
    const r = await this.row(name, version, id);
    return { ...this.dto(r), parts: r.uploadId && r.state === 'UPLOADING' ? await this.parts(r) : [] };
  }
  async part(user: Session, name: string, version: number, id: string, number: number, sha: string) {
    await this.scope(user, name, version);
    const r = await this.row(name, version, id);
    if (r.state !== 'UPLOADING') throw error(409, 'Upload does not accept parts');
    if (!Number.isInteger(number) || number < 1 || number > r.partCount || !checksum(sha)) throw error(400, 'Invalid part');
    const bytes = Math.min(r.partSize, r.size - (number - 1) * r.partSize);
    return {
      url: await this.deps.sign(new UploadPartCommand({ Bucket: r.bucket, Key: r.key, UploadId: r.uploadId, PartNumber: number, ContentLength: bytes, ChecksumSHA256: sha })),
      headers: { 'x-amz-checksum-sha256': sha }
    };
  }
  private async verified(r: MultipartSession) {
    try {
      const h = await this.deps.client.send(new HeadObjectCommand({ Bucket: r.bucket, Key: r.key, ChecksumMode: 'ENABLED' }), { abortSignal: AbortSignal.timeout(60_000) });
      if (h.Metadata?.['pai-upload'] !== r.id || h.ContentLength !== r.size || h.ChecksumType && h.ChecksumType !== 'COMPOSITE' || !h.VersionId || h.VersionId === 'null' || !r.composite || h.ChecksumSHA256 !== r.composite) throw error(409, 'Completed object verification failed');
      return h.VersionId;
    } catch (e) {
      if (['NotFound', 'NoSuchKey'].includes((e as Error).name)) return;
      throw e;
    }
  }
  async complete(user: Session, name: string, version: number, id: string, checksums: string[]) {
    await this.scope(user, name, version);
    return this.locked(await this.row(name, version, id), async (r, lease) => {
      if (!Array.isArray(checksums) || checksums.length !== r.partCount || !checksums.every(checksum)) throw error(400, 'Expected part checksums are required');
      const composite = createHash('sha256').update(Buffer.concat(checksums.map(c => Buffer.from(c, 'base64')))).digest('base64') + `-${r.partCount}`;
      if (r.composite && r.composite !== composite) throw error(409, 'Selected file differs from the completed file');
      if (r.state === 'COMPLETED') return this.dto(r);
      if (!['UPLOADING', 'COMPLETING'].includes(r.state)) throw error(409, 'Upload cannot complete');
      if (r.state === 'COMPLETING') {
        const versionId = await this.verified(r);
        if (versionId) return this.dto(await this.change(r, { state: 'COMPLETED', versionId }, lease));
      }
      const parts = await this.parts(r);
      if (parts.length !== r.partCount || parts.some((p, i) => p.number !== i + 1 || p.size !== Math.min(r.partSize, r.size - i * r.partSize) || !p.etag || p.checksum !== checksums[i])) throw error(409, 'S3 parts do not match the expected file');
      if (r.state !== 'COMPLETING') r = await this.change(r, { state: 'COMPLETING', composite }, lease);
      await this.deps.client.send(new CompleteMultipartUploadCommand({
        Bucket: r.bucket,
        Key: r.key,
        UploadId: r.uploadId,
        ChecksumType: 'COMPOSITE',
        MultipartUpload: { Parts: parts.map(p => ({ PartNumber: p.number, ETag: p.etag, ChecksumSHA256: p.checksum })) }
      }), { abortSignal: AbortSignal.timeout(60_000) });
      const versionId = await this.verified(r);
      if (!versionId) throw error(409, 'Completed object is not visible yet; resume');
      return this.dto(await this.change(r, { state: 'COMPLETED', versionId }, lease));
    });
  }
  async abort(user: Session, name: string, version: number, id: string) {
    await this.scope(user, name, version);
    return this.locked(await this.row(name, version, id), async (r, lease) => {
      if (terminal(r.state)) return this.dto(r);
      if (r.state === 'COMPLETING') {
        const versionId = await this.verified(r);
        if (versionId) return this.dto(await this.change(r, { state: 'COMPLETED', versionId }, lease));
      }
      const ids = r.uploadId ? [r.uploadId] : await this.initiations(r);
      if (r.state !== 'ABORTING') r = await this.change(r, { state: 'ABORTING' }, lease);
      for (const uploadId of ids) {
        try {
          await this.deps.client.send(new AbortMultipartUploadCommand({ Bucket: r.bucket, Key: r.key, UploadId: uploadId }), { abortSignal: AbortSignal.timeout(60_000) });
        } catch (e) {
          if ((e as Error).name !== 'NoSuchUpload') throw e;
        }
        try {
          await this.parts({ ...r, uploadId });
          throw error(409, 'S3 abort is still pending; retry');
        } catch (e) {
          if ((e as Error).name !== 'NoSuchUpload') throw e;
        }
      }
      const committed = r.composite ? await this.verified(r) : undefined;
      if (committed) return this.dto(await this.change(r, { state: 'COMPLETED', versionId: committed }, lease));
      return this.dto(await this.change(r, { state: 'ABORTED' }, lease));
    });
  }
}
