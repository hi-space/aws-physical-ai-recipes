import { createHash } from 'node:crypto';
import {
  AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CopyObjectCommand,
  CreateMultipartUploadCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command,
  PutObjectCommand, UploadPartCopyCommand, type HeadObjectCommandOutput,
} from '@aws-sdk/client-s3';
import { s3 } from '../aws/clients';
import type { ArtifactInventory, InventoryFile } from '../workflow-adapters/artifact-inventory';

export interface SnapshotObject {
  path: string;
  key: string;
  versionId: string;
  bytes: number;
  checksumSHA256: string;
  checksumType: string;
  /** Independently streamed full-file digest, never a relabeled multipart checksum. */
  fullSHA256?: string;
}
export interface SnapshotManifest {
  schemaVersion: 1;
  identity: string;
  createdAt: string;
  source: { bucket: string; prefix: string };
  objects: SnapshotObject[];
  inventoryHash?: string;
}
export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const encodedSource = (bucket: string, key: string, versionId?: string) =>
  `${bucket}/${key.split('/').map(encodeURIComponent).join('/')}${versionId ? `?versionId=${encodeURIComponent(versionId)}` : ''}`;

export class SnapshotPendingError extends Error {
  constructor(message: string) { super(message); this.name = 'SnapshotPendingError'; }
}
const missing = (error: unknown) => ['NoSuchKey', 'NotFound', 'NoSuchVersion'].includes((error as Error).name);
const validVersion = (id: string | undefined) => !!id && id !== 'null';
const fullChecksum = (value: string) => {
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== 32 || decoded.toString('base64') !== value) throw new Error('Invalid SHA256 checksum');
  return decoded.toString('hex');
};
type SourceHead = HeadObjectCommandOutput;
interface PinnedSource { bucket: string; key: string; path: string; head?: SourceHead; expected?: InventoryFile }

/** Bounded memory even for large models. Abort or excess bytes cannot produce a digest. */
export async function streamedSHA256(input: {
  bucket: string; key: string; versionId?: string; etag?: string; bytes: number; signal?: AbortSignal;
}) {
  const response = await s3().send(new GetObjectCommand({
    Bucket: input.bucket, Key: input.key, VersionId: validVersion(input.versionId) ? input.versionId : undefined,
    IfMatch: input.etag, ChecksumMode: 'ENABLED',
  }), { abortSignal: input.signal });
  if (response.ContentLength !== input.bytes || validVersion(input.versionId) && response.VersionId !== input.versionId) {
    (response.Body as { destroy?: () => void } | undefined)?.destroy?.();
    throw new SnapshotPendingError('Artifact changed while reading its pinned bytes');
  }
  const body = response.Body as AsyncIterable<Uint8Array> & { destroy?: () => void };
  if (!body?.[Symbol.asyncIterator]) throw new Error('Artifact body must support bounded streaming');
  const digest = createHash('sha256'); let bytes = 0;
  try {
    for await (const block of body) {
      input.signal?.throwIfAborted();
      bytes += block.byteLength;
      if (bytes > input.bytes) throw new Error('Artifact stream exceeded declared size');
      digest.update(block);
    }
    if (bytes !== input.bytes) throw new Error('Artifact stream was truncated');
    return digest.digest('hex');
  } finally { body.destroy?.(); }
}

async function expectedSources(input: SnapshotInput): Promise<PinnedSource[]> {
  const inventory = input.inventory!;
  if (!inventory.files.length || new Set(inventory.files.map(file => file.path)).size !== inventory.files.length) throw new Error('Invalid trusted inventory');
  const sources: PinnedSource[] = [];
  const prefix = input.sourcePrefix.replace(/\/?$/, '/');
  for (const file of inventory.files) {
    input.signal?.throwIfAborted();
    if (!file.path || file.path.startsWith('/') || /[\\\u0000-\u001f]/.test(file.path) ||
        file.path.split('/').some(part => !part || part === '.' || part === '..') ||
        file.path === 'manifest.json' || file.path === '.pai' || file.path.startsWith('.pai/') ||
        !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('Invalid trusted inventory file');
    const key = inventory.kind === 'file' ? input.sourcePrefix : prefix + file.path;
    let head;
    try { head = await s3().send(new HeadObjectCommand({ Bucket: input.sourceBucket, Key: key, ChecksumMode: 'ENABLED' }), { abortSignal: input.signal }); }
    catch (error) { if (missing(error)) throw new SnapshotPendingError(`Waiting for AutoExport: ${file.path}`); throw error; }
    if (head.ContentLength !== file.bytes) throw new SnapshotPendingError(`Waiting for matching exported size: ${file.path}`);
    if (!head.ETag) throw new Error('Exported object has no copy precondition');
    let digest: string;
    if (head.ChecksumSHA256 && (head.ChecksumType ?? 'FULL_OBJECT') === 'FULL_OBJECT') digest = fullChecksum(head.ChecksumSHA256);
    else {
      try {
        digest = await streamedSHA256({ bucket: input.sourceBucket, key, versionId: head.VersionId, etag: head.ETag, bytes: file.bytes, signal: input.signal });
      } catch (error) {
        if (missing(error) || (error as Error).name === 'PreconditionFailed') throw new SnapshotPendingError(`Export changed: ${file.path}`);
        throw error;
      }
    }
    if (digest !== file.sha256) throw new SnapshotPendingError(`Waiting for matching exported SHA256: ${file.path}`);
    sources.push({ bucket: input.sourceBucket, key, path: file.path, expected: file, head });
  }
  return sources;
}

/** The limit is injectable for exercising multipart copies with small test data;
 * production calls use the S3 CopyObject limit. It may only be lowered. */
export async function copyVerified(source: PinnedSource, target: { bucket: string; key: string }, signal?: AbortSignal,
  singleCopyLimitBytes = 5 * 1024 ** 3): Promise<SnapshotObject> {
  if (!Number.isSafeInteger(singleCopyLimitBytes) || singleCopyLimitBytes < 1 || singleCopyLimitBytes > 5 * 1024 ** 3) throw new Error('Invalid single-copy limit');
  const client = s3();
  const head = source.head ?? await client.send(new HeadObjectCommand({ Bucket: source.bucket, Key: source.key }), { abortSignal: signal });
  const bytes = head.ContentLength ?? 0;
  const CopySource = encodedSource(source.bucket, source.key, validVersion(head.VersionId) ? head.VersionId : undefined);
  let versionId: string | undefined;
  if (bytes <= singleCopyLimitBytes) {
    const copied = await client.send(new CopyObjectCommand({
      Bucket: target.bucket, Key: target.key, CopySource, CopySourceIfMatch: head.ETag, ChecksumAlgorithm: 'SHA256',
    }), { abortSignal: signal });
    versionId = copied.VersionId;
  } else {
    const started = await client.send(new CreateMultipartUploadCommand({
      Bucket: target.bucket, Key: target.key, ContentType: head.ContentType, ChecksumAlgorithm: 'SHA256', ChecksumType: 'COMPOSITE',
    }), { abortSignal: signal });
    const UploadId = started.UploadId;
    if (!UploadId) throw new Error('Multipart snapshot upload did not return an ID');
    try {
      const parts: { PartNumber: number; ETag?: string; ChecksumSHA256?: string }[] = [];
      const partSize = Math.max(512 * 1024 ** 2, Math.ceil(bytes / 9000));
      for (let start = 0, part = 1; start < bytes; start += partSize, part++) {
        const copied = await client.send(new UploadPartCopyCommand({
          Bucket: target.bucket, Key: target.key, UploadId, PartNumber: part,
          CopySource, CopySourceIfMatch: head.ETag,
          CopySourceRange: `bytes=${start}-${Math.min(bytes - 1, start + partSize - 1)}`,
        }), { abortSignal: signal });
        if (!copied.CopyPartResult?.ETag || !copied.CopyPartResult.ChecksumSHA256) throw new Error('Multipart copy has no verified part checksum');
        parts.push({ PartNumber: part, ETag: copied.CopyPartResult.ETag, ChecksumSHA256: copied.CopyPartResult.ChecksumSHA256 });
      }
      const completed = await client.send(new CompleteMultipartUploadCommand({
        Bucket: target.bucket, Key: target.key, UploadId, MultipartUpload: { Parts: parts }, ChecksumType: 'COMPOSITE',
      }), { abortSignal: signal });
      versionId = completed.VersionId;
    } catch (error) {
      await client.send(new AbortMultipartUploadCommand({ Bucket: target.bucket, Key: target.key, UploadId })).catch(() => undefined);
      throw error;
    }
  }
  if (!validVersion(versionId)) throw new Error('Snapshot copy requires destination bucket versioning');
  const verified = await client.send(new HeadObjectCommand({ Bucket: target.bucket, Key: target.key, VersionId: versionId, ChecksumMode: 'ENABLED' }), { abortSignal: signal });
  if (verified.VersionId !== versionId || !verified.ChecksumSHA256 || verified.ContentLength !== bytes) throw new Error('Snapshot object verification failed');
  const checksumType = verified.ChecksumType ?? 'FULL_OBJECT';
  if (!['FULL_OBJECT', 'COMPOSITE'].includes(checksumType)) throw new Error('Unsupported snapshot checksum type');
  let fullSHA256: string | undefined;
  if (source.expected) {
    if (checksumType === 'FULL_OBJECT') fullSHA256 = fullChecksum(verified.ChecksumSHA256);
    else {
      if (!/^[A-Za-z0-9+/]{43}=-[1-9]\d*$/.test(verified.ChecksumSHA256)) throw new Error('Invalid composite snapshot checksum');
      fullSHA256 = await streamedSHA256({ bucket: target.bucket, key: target.key, versionId, bytes, signal });
    }
    if (fullSHA256 !== source.expected.sha256) throw new SnapshotPendingError(`Copied content does not match trusted inventory: ${source.path}`);
  }
  return { path: source.path, key: target.key, versionId: verified.VersionId!, bytes, checksumSHA256: verified.ChecksumSHA256,
    checksumType, ...(fullSHA256 ? { fullSHA256 } : {}) };
}

export async function loadSnapshot(bucket: string, key: string, signal?: AbortSignal) {
  const response = await s3().send(new GetObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: signal });
  if ((response.ContentLength ?? 0) > 8 * 1024 * 1024) throw new Error('Snapshot manifest exceeds 8 MiB');
  const text = await response.Body!.transformToString();
  if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw new Error('Snapshot manifest exceeds 8 MiB');
  const manifest = JSON.parse(text) as SnapshotManifest;
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.objects) || !manifest.objects.length) throw new Error('Invalid snapshot manifest');
  return { manifest, hash: sha256(text) };
}

export interface SnapshotInput {
  sourceBucket: string; sourcePrefix: string; targetBucket: string; targetPrefix: string;
  identity: string; signal?: AbortSignal; inventory?: ArtifactInventory;
  /** Recheck cancellation/attempt fencing around side effects and before adoption. */
  assertCurrent?: () => Promise<void>;
}
async function validateExisting(manifest: SnapshotManifest, input: SnapshotInput) {
  if (manifest.identity !== input.identity) throw new Error('Snapshot identity mismatch');
  if (!input.inventory) return;
  if (input.inventory.identity !== input.identity || manifest.inventoryHash !== input.inventory.hash ||
      manifest.objects.length !== input.inventory.files.length) throw new Error('Snapshot does not match trusted inventory');
  const prefix = input.targetPrefix.replace(/\/?$/, '/');
  if (new Set(manifest.objects.map(object => object.path)).size !== manifest.objects.length) throw new Error('Duplicate snapshot objects');
  for (const file of input.inventory.files) {
    const object = manifest.objects.find(object => object.path === file.path);
    if (!object || object.key !== prefix + file.path || object.bytes !== file.bytes || !validVersion(object.versionId) ||
        (object.checksumType === 'FULL_OBJECT' ? fullChecksum(object.checksumSHA256) : object.fullSHA256) !== file.sha256) {
      throw new Error('Snapshot object does not match trusted inventory');
    }
    const head = await s3().send(new HeadObjectCommand({
      Bucket: input.targetBucket, Key: object.key, VersionId: object.versionId, ChecksumMode: 'ENABLED',
    }), { abortSignal: input.signal });
    if (head.VersionId !== object.versionId || head.ContentLength !== object.bytes ||
        head.ChecksumSHA256 !== object.checksumSHA256 || (head.ChecksumType ?? 'FULL_OBJECT') !== object.checksumType) {
      throw new Error('Committed snapshot version verification failed');
    }
  }
}

/** S3 versions/checksums, not mutable prefixes, form the committed dataset. */
export async function snapshotPrefix(input: SnapshotInput) {
  input.signal?.throwIfAborted();
  await input.assertCurrent?.();
  if (input.inventory && input.inventory.identity !== input.identity) throw new Error('Inventory identity mismatch');
  const targetPrefix = input.targetPrefix.replace(/\/?$/, '/');
  const manifestKey = `${targetPrefix}manifest.json`;
  try {
    const existing = await loadSnapshot(input.targetBucket, manifestKey, input.signal);
    await validateExisting(existing.manifest, input);
    await input.assertCurrent?.();
    return existing;
  } catch (error) {
    if (!['NoSuchKey', 'NotFound'].includes((error as Error).name)) throw error;
  }
  const objects: SnapshotObject[] = [];
  const sourcePrefix = input.sourcePrefix.replace(/\/?$/, '/');
  if (input.inventory) {
    // Every expected object must match BEFORE copying or publishing anything.
    // No ListObjects call participates in inventory-backed completeness.
    const sources = await expectedSources(input);
    for (const source of sources) {
      await input.assertCurrent?.();
      try { objects.push(await copyVerified(source, { bucket: input.targetBucket, key: targetPrefix + source.path }, input.signal)); }
      catch (error) {
        if (missing(error) || (error as Error).name === 'PreconditionFailed') throw new SnapshotPendingError(`Export changed before copy: ${source.path}`);
        throw error;
      }
    }
  } else {
    let singleObject: { Key: string } | undefined;
    if (!input.sourcePrefix.endsWith('/')) {
      try {
        await s3().send(new HeadObjectCommand({ Bucket: input.sourceBucket, Key: input.sourcePrefix }), { abortSignal: input.signal });
        singleObject = { Key: input.sourcePrefix };
      } catch (error) { if (!['NotFound', 'NoSuchKey'].includes((error as Error).name)) throw error; }
    }
    let token: string | undefined;
    do {
      const page = singleObject ? { Contents: [singleObject], NextContinuationToken: undefined } : await s3().send(new ListObjectsV2Command({
        Bucket: input.sourceBucket, Prefix: sourcePrefix, ContinuationToken: token,
      }), { abortSignal: input.signal });
      const sources = (page.Contents ?? []).filter((object) => object.Key && !object.Key.endsWith('/') && !['.dataset.json', 'manifest.json'].includes(object.Key.slice(sourcePrefix.length)));
      for (let offset = 0; offset < sources.length; offset += 8) {
        const results = await Promise.all(sources.slice(offset, offset + 8).map((object) => {
          const path = singleObject ? object.Key!.split('/').pop()! : object.Key!.slice(sourcePrefix.length);
          if (!path || path.split('/').some((segment) => segment === '..' || segment === '.')) throw new Error('Unsafe snapshot object path');
          return copyVerified({ bucket: input.sourceBucket, key: object.Key!, path }, { bucket: input.targetBucket, key: targetPrefix + path }, input.signal);
        }));
        objects.push(...results);
      }
      token = page.NextContinuationToken;
    } while (token);
  }
  if (!objects.length) throw new Error('No data files were uploaded');
  objects.sort((a, b) => a.path.localeCompare(b.path));
  const manifest: SnapshotManifest = {
    schemaVersion: 1, identity: input.identity, createdAt: new Date().toISOString(),
    source: { bucket: input.sourceBucket, prefix: input.inventory?.kind === 'file' ? input.sourcePrefix : sourcePrefix }, objects,
    ...(input.inventory ? { inventoryHash: input.inventory.hash } : {}),
  };
  const text = JSON.stringify(manifest);
  if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw new Error('Snapshot manifest exceeds 8 MiB');
  input.signal?.throwIfAborted();
  await input.assertCurrent?.();
  try {
    await s3().send(new PutObjectCommand({
      Bucket: input.targetBucket, Key: manifestKey, Body: text,
      ContentType: 'application/json', ChecksumAlgorithm: 'SHA256', IfNoneMatch: '*',
    }), { abortSignal: input.signal });
  } catch (error) {
    if ((error as Error).name !== 'PreconditionFailed') throw error;
    const existing = await loadSnapshot(input.targetBucket, manifestKey, input.signal);
    await validateExisting(existing.manifest, input);
    await input.assertCurrent?.();
    return existing;
  }
  await input.assertCurrent?.();
  return { manifest, hash: sha256(text) };
}
