import { createHash } from 'node:crypto';
import { z } from 'zod';
import { badRequest, notConfigured } from '../errors';
import type { DatasetVersion } from '../store/types';
import { safeRelativePath, sha256Schema } from './report';
import type { DatasetPin, ObjectPin } from './types';

export interface ObjectReference { bucket: string; key: string; versionId?: string }
export interface ObjectMetadata {
  versionId?: string;
  bytes: number;
  checksumSHA256?: string;
  checksumType?: string;
}
export interface ObjectStorage {
  head(reference: ObjectReference): Promise<ObjectMetadata>;
  get(reference: ObjectReference & { versionId: string }, maximumBytes: number): Promise<{ metadata: ObjectMetadata; body: Uint8Array }>;
  presign(reference: ObjectReference & { versionId: string }): Promise<string>;
}
const objectSchema = z.object({
  path: z.string().min(1).max(2048), key: z.string().min(1).max(4096),
  versionId: z.string().min(1).max(1024).refine(v => v !== 'null'),
  bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  checksumSHA256: z.string().min(1).max(256),
  checksumType: z.enum(['FULL_OBJECT', 'COMPOSITE']),
});
const manifestSchema = z.object({
  schemaVersion: z.literal(1), identity: z.string().min(1),
  createdAt: z.string().datetime(),
  objects: z.array(objectSchema).min(1).max(25_000),
});
export const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
export function scopedS3(uri: string, projectId: string, bucket: string) {
  if (!bucket) throw notConfigured('DASHBOARD_ARTIFACT_BUCKET');
  const match = /^s3:\/\/([^/]+)\/(.+)$/.exec(uri);
  if (!match || match[1] !== bucket || !match[2].startsWith(`projects/${projectId}/`)) throw badRequest('Published artifact is outside this project archive');
  safeRelativePath(match[2].replace(/\/$/, ''));
  return { bucket, key: match[2] };
}
function fullDigest(checksum: string): string {
  const bytes = Buffer.from(checksum, 'base64');
  if (bytes.length !== 32 || bytes.toString('base64') !== checksum) throw badRequest('Invalid full-object SHA256 checksum');
  return bytes.toString('hex');
}
function checksumDigest(checksum: string, type: string): string | undefined {
  if (type === 'FULL_OBJECT') return fullDigest(checksum);
  if (type !== 'COMPOSITE' || !/^[A-Za-z0-9+/]{43}=-[1-9]\d*$/.test(checksum)) throw badRequest('Invalid composite SHA256 checksum');
  return undefined;
}
function checkHead(expected: ObjectPin, actual: ObjectMetadata) {
  if (actual.versionId !== expected.versionId || actual.bytes !== expected.bytes ||
      actual.checksumSHA256 !== expected.checksumSHA256 ||
      (actual.checksumType ?? 'FULL_OBJECT') !== expected.checksumType) throw badRequest('Published object VersionId/checksum does not match the snapshot');
}
function parseJson(body: Uint8Array): unknown {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); }
  catch { throw badRequest('Published evidence must be valid UTF-8 JSON'); }
}
export interface VerifiedSnapshot {
  dataset: DatasetPin;
  manifest: ObjectPin;
  objects: Map<string, ObjectPin>;
}

export class EvidenceReader {
  constructor(readonly objects: ObjectStorage, readonly bucket: string) {}

  async snapshot(projectId: string, version: DatasetVersion): Promise<VerifiedSnapshot> {
    if (version.state !== 'READY' || !version.manifestUri || !version.manifestHash ||
        !sha256Schema.safeParse(version.manifestHash).success) throw badRequest('A READY version with a verified publication manifest is required');
    const root = scopedS3(version.uri, projectId, this.bucket);
    const reference = scopedS3(version.manifestUri, projectId, this.bucket);
    if (!root.key.endsWith('/') || reference.key !== root.key + 'manifest.json') throw badRequest('Manifest must belong to this exact dataset snapshot');
    const head = await this.objects.head(reference);
    if (!head.versionId || head.versionId === 'null' || !head.checksumSHA256 || head.bytes <= 0 || head.bytes > 8 * 1024 * 1024) throw badRequest('Versioned manifest with checksum is required (maximum 8 MiB)');
    const manifestPin: ObjectPin = {
      ...reference, path: 'manifest.json', versionId: head.versionId, bytes: head.bytes,
      checksumSHA256: head.checksumSHA256, checksumType: head.checksumType === 'COMPOSITE' ? 'COMPOSITE' : 'FULL_OBJECT',
    };
    // Dataset's committed full content hash is authoritative, including for a multipart manifest.
    const fetched = await this.objects.get(manifestPin, 8 * 1024 * 1024);
    checkHead(manifestPin, fetched.metadata);
    if (fetched.body.byteLength !== head.bytes || digest(fetched.body) !== version.manifestHash.toLowerCase()) throw badRequest('Publication manifest hash mismatch');
    manifestPin.sha256 = version.manifestHash.toLowerCase();
    const parsed = manifestSchema.safeParse(parseJson(fetched.body));
    if (!parsed.success) throw badRequest('Invalid published snapshot manifest');
    if (!version.publicationId || !version.producedAttempt ||
        parsed.data.identity !== `workflow:${version.publicationId}:${version.producedAttempt}`) throw badRequest('Manifest is not the declared runtime publication');
    const objects = new Map<string, ObjectPin>();
    for (const entry of parsed.data.objects) {
      safeRelativePath(entry.path);
      if (entry.key !== root.key + entry.path || objects.has(entry.path)) throw badRequest('Snapshot contains an escaping or duplicate object path');
      objects.set(entry.path, { ...entry, bucket: root.bucket, sha256: checksumDigest(entry.checksumSHA256, entry.checksumType) });
    }
    return {
      dataset: { name: version.dataset, version: version.version, uri: version.uri,
        manifestUri: version.manifestUri, manifestHash: manifestPin.sha256, manifestVersionId: manifestPin.versionId },
      manifest: manifestPin, objects,
    };
  }

  select(snapshot: VerifiedSnapshot, path: string): ObjectPin {
    safeRelativePath(path);
    const object = snapshot.objects.get(path);
    if (!object) throw badRequest('Selected file is not part of the READY dataset manifest');
    return object;
  }
  async verify(object: ObjectPin): Promise<ObjectPin> {
    checkHead(object, await this.objects.head(object));
    return object;
  }
  async json(object: ObjectPin, maximumBytes = 4 * 1024 * 1024): Promise<unknown> {
    await this.verify(object);
    if (object.bytes <= 0 || object.bytes > maximumBytes) throw badRequest('Evidence JSON exceeds the supported size limit');
    // JSON reports are small and require a full-object checksum to bind the actual bytes.
    if (!object.sha256) throw badRequest('Evidence JSON requires a full-object SHA256 checksum');
    const fetched = await this.objects.get(object, maximumBytes);
    checkHead(object, fetched.metadata);
    if (fetched.body.byteLength !== object.bytes || digest(fetched.body) !== object.sha256) throw badRequest('Evidence content digest mismatch');
    return parseJson(fetched.body);
  }
}
