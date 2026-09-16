import { createHash } from 'node:crypto';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { s3 } from '../aws/clients';
import { badRequest } from '../errors';
import { copyVerified, streamedSHA256 } from '../storage/snapshots';
import { inspectCheckpointTar } from './bundles';
import { digest, scopedS3 } from './evidence';
import { normalizeEvaluationReport, normalizeSmokeReport, safeRelativePath } from './report';
import type { ObjectPin } from './types';
import type { PipelineArchiveManifest, PipelineObjectSource, PipelineProvenance } from './pipeline-types';
import { inputChecksumType } from '../runtime/checksums';

export interface ArchivedPipeline {
  manifest: PipelineArchiveManifest; manifestPin: ObjectPin;
}
export interface PipelineArchiveStorage {
  archive(source: PipelineProvenance, projectId: string, id: string, createdAt: string, signal: AbortSignal): Promise<ArchivedPipeline>;
  verifyOriginal(source: PipelineObjectSource): Promise<void>;
}
const version = (value?: string) => value && value !== 'null' ? value : undefined;
function split(uri: string) {
  const match = /^s3:\/\/([^/]+)\/(.+)$/.exec(uri);
  if (!match) throw badRequest('Invalid backend artifact URI');
  safeRelativePath(match[2]); return { bucket: match[1], key: match[2] };
}
function pin(path: string, bucket: string, file: Awaited<ReturnType<typeof copyVerified>>): ObjectPin {
  const sha = file.fullSHA256 ?? (file.checksumType === 'FULL_OBJECT' ? Buffer.from(file.checksumSHA256, 'base64').toString('hex') : undefined);
  if (!sha || !/^[a-f0-9]{64}$/.test(sha)) throw badRequest('Archive lacks an independently verified full-file digest');
  return { ...file, bucket, path, checksumType: file.checksumType as ObjectPin['checksumType'], sha256: sha,
    ...(file.checksumType === 'COMPOSITE' ? { sha256Verification: 'streamed-version' as const } : {}) };
}

/** Actual S3 reads/copies are only made when an authorized archive operation is
 * reconciled. Tar members are hashed in bounded memory; no extraction or exec. */
export class S3PipelineArchiveStorage implements PipelineArchiveStorage {
  constructor(readonly bucket: string) {}
  private async open(uri: string, signal: AbortSignal, maximum = 100 * 1024 ** 3) {
    const ref = split(uri);
    const head = await s3().send(new HeadObjectCommand({ Bucket: ref.bucket, Key: ref.key, ChecksumMode: 'ENABLED' }), { abortSignal: signal });
    if (!head.ETag || !Number.isSafeInteger(head.ContentLength) || head.ContentLength! <= 0 || head.ContentLength! > maximum) throw badRequest('Source artifact size/identity is invalid');
    const response = await s3().send(new GetObjectCommand({
      Bucket: ref.bucket, Key: ref.key, VersionId: version(head.VersionId), IfMatch: head.ETag, ChecksumMode: 'ENABLED',
    }), { abortSignal: signal });
    const body = response.Body as AsyncIterable<Uint8Array> & { destroy?: () => void };
    if (!body?.[Symbol.asyncIterator] || response.ContentLength !== head.ContentLength ||
        version(response.VersionId) !== version(head.VersionId)) throw badRequest('Source object changed while opening');
    let bytes = 0; const hash = createHash('sha256');
    async function* chunks() {
      try {
        for await (const chunk of body) {
          signal.throwIfAborted(); bytes += chunk.byteLength;
          if (bytes > head.ContentLength!) throw badRequest('Source body exceeded its pinned size');
          hash.update(chunk); yield chunk;
        }
        if (bytes !== head.ContentLength) throw badRequest('Source body was truncated');
      } finally { body.destroy?.(); }
    }
    return { ref, head, chunks: chunks(), source: (): PipelineObjectSource => {
      if (bytes !== head.ContentLength) throw badRequest('Source was not completely read');
      return { uri, ...ref, versionId: version(head.VersionId), etag: head.ETag!, bytes, sha256: hash.digest('hex') };
    } };
  }
  private async json(key: string, value: unknown, path: string, signal: AbortSignal): Promise<ObjectPin> {
    const bytes = Buffer.from(JSON.stringify(value));
    if (bytes.length > 8 * 1024 * 1024) throw badRequest('Archive manifest exceeds 8 MiB');
    let id: string | undefined;
    try {
      const response = await s3().send(new PutObjectCommand({
        Bucket: this.bucket, Key: key, Body: bytes, ContentType: 'application/json', IfNoneMatch: '*',
        ChecksumAlgorithm: 'SHA256', ChecksumSHA256: createHash('sha256').update(bytes).digest('base64'),
      }), { abortSignal: signal });
      id = response.VersionId;
    } catch (error) {
      if ((error as Error).name !== 'PreconditionFailed') throw error;
      const existing = await this.open(`s3://${this.bucket}/${key}`, signal, 8 * 1024 * 1024);
      for await (const _ of existing.chunks) { /* verify complete immutable object */ }
      const original = existing.source();
      if (original.sha256 !== digest(bytes)) throw badRequest('Archive key already contains different evidence');
      id = original.versionId;
    }
    if (!version(id)) throw badRequest('Project archive bucket must have versioning enabled');
    const head = await s3().send(new HeadObjectCommand({ Bucket: this.bucket, Key: key, VersionId: id, ChecksumMode: 'ENABLED' }), { abortSignal: signal });
    if (head.VersionId !== id || head.ContentLength !== bytes.length ||
        head.ChecksumSHA256 !== createHash('sha256').update(bytes).digest('base64') || inputChecksumType(head.ChecksumType, head.ChecksumSHA256) !== 'FULL_OBJECT') throw badRequest('Archive JSON write verification failed');
    return { bucket: this.bucket, key, path, versionId: id!, bytes: bytes.length, checksumSHA256: head.ChecksumSHA256!,
      checksumType: 'FULL_OBJECT', sha256: digest(bytes) };
  }
  private async copy(source: PipelineObjectSource, prefix: string, path: string, signal: AbortSignal) {
    safeRelativePath(path);
    const file = await copyVerified({ bucket: source.bucket, key: source.key, path,
      head: { $metadata: {}, ContentLength: source.bytes, VersionId: source.versionId, ETag: source.etag },
      expected: { path, bytes: source.bytes, sha256: source.sha256 } },
    { bucket: this.bucket, key: prefix + path }, signal);
    return pin(path, this.bucket, file);
  }
  async archive(source: PipelineProvenance, projectId: string, id: string, createdAt: string, signal: AbortSignal): Promise<ArchivedPipeline> {
    const prefix = `projects/${projectId}/pipeline-archives/${id}/`, identity = `pipeline:${id}`;
    scopedS3(`s3://${this.bucket}/${prefix}`, projectId, this.bucket);
    try {
      const old = await this.open(`s3://${this.bucket}/${prefix}manifest.json`, signal, 8 * 1024 * 1024);
      const chunks: Buffer[] = []; for await (const chunk of old.chunks) chunks.push(Buffer.from(chunk));
      const sourcePin = old.source(), manifest = JSON.parse(Buffer.concat(chunks).toString('utf8')) as PipelineArchiveManifest;
      if (manifest.identity !== identity || digest(JSON.stringify(manifest.source)) !== digest(JSON.stringify(source)) ||
          !manifest.objects.length || new Set(manifest.objects.map(file => file.path)).size !== manifest.objects.length) throw badRequest('Existing archive provenance mismatch');
      for (const object of manifest.objects) {
        if (object.bucket !== this.bucket || object.key !== prefix + safeRelativePath(object.path) || !version(object.versionId)) throw badRequest('Existing archive escapes its scope');
        const head = await s3().send(new HeadObjectCommand({ Bucket: this.bucket, Key: object.key, VersionId: object.versionId, ChecksumMode: 'ENABLED' }), { abortSignal: signal });
        if (head.ContentLength !== object.bytes || head.VersionId !== object.versionId || head.ChecksumSHA256 !== object.checksumSHA256 ||
            inputChecksumType(head.ChecksumType, head.ChecksumSHA256) !== object.checksumType) throw badRequest('Existing archive object verification failed');
      }
      const checksumType = inputChecksumType(old.head.ChecksumType, old.head.ChecksumSHA256);
      if (!sourcePin.versionId || !old.head.ChecksumSHA256 || !checksumType) throw badRequest('Archive manifest has no versioned checksum');
      const manifestPin: ObjectPin = { ...sourcePin, path: 'manifest.json', versionId: sourcePin.versionId,
        checksumType, checksumSHA256: old.head.ChecksumSHA256 };
      return { manifest, manifestPin };
    } catch (error) { if (!['NotFound', 'NoSuchKey'].includes((error as Error).name)) throw error; }
    const original = await this.open(source.training.artifactUri, signal);
    const directory = await inspectCheckpointTar(original.chunks, signal);
    const originalPin = original.source(), checkpointPath = 'model/model.tar.gz';
    const checkpoint = await this.copy(originalPin, prefix, checkpointPath, signal);
    const directoryManifestPath = 'model/bundle.json';
    const directoryPin = await this.json(prefix + directoryManifestPath, {
      ...directory, checkpoint: { path: checkpointPath, sha256: checkpoint.sha256 },
    }, directoryManifestPath, signal);
    const objects = [checkpoint, directoryPin], reports: PipelineArchiveManifest['reports'] = [];
    for (const report of source.reports) {
      const opened = await this.open(report.uri, signal, 4 * 1024 * 1024), chunks: Buffer[] = [];
      for await (const chunk of opened.chunks) chunks.push(Buffer.from(chunk));
      const object = opened.source();
      let value: unknown; try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw badRequest('Backend report is not JSON'); }
      const videoPaths = value && typeof value === 'object' && 'smoke' in value
        ? (normalizeSmokeReport(value), []) : normalizeEvaluationReport(value).videoPaths;
      const reportPath = `reports/${report.step}/evaluation.json`;
      const reportPin = await this.copy(object, prefix, reportPath, signal), videos: ObjectPin[] = [];
      for (const path of videoPaths) {
        safeRelativePath(path);
        const uri = report.uri.slice(0, report.uri.lastIndexOf('/') + 1) + path;
        const video = await this.open(uri, signal);
        for await (const _ of video.chunks) { /* independently hash full video */ }
        const videoPin = await this.copy(video.source(), prefix, `reports/${report.step}/${path}`, signal);
        if (!videoPin.path.endsWith('.mp4')) throw badRequest('Evaluation video must be MP4');
        videos.push(videoPin); objects.push(videoPin);
      }
      objects.push(reportPin);
      reports.push({ step: report.step, report: reportPin, videos, source: report, sourceObject: object });
    }
    const manifest: PipelineArchiveManifest = {
      schemaVersion: 1, identity, createdAt, source, sourceObject: originalPin,
      objects: objects.map(object => ({ ...object, fullSHA256: object.sha256 })), checkpointPath, directory, directoryManifestPath, reports,
    };
    const manifestPin = await this.json(prefix + 'manifest.json', manifest, 'manifest.json', signal);
    return { manifest, manifestPin };
  }
  async verifyOriginal(source: PipelineObjectSource) {
    const head = await s3().send(new HeadObjectCommand({ Bucket: source.bucket, Key: source.key, ChecksumMode: 'ENABLED' }));
    if (head.ContentLength !== source.bytes || version(head.VersionId) !== source.versionId || head.ETag !== source.etag) throw badRequest('Original ModelPackage artifact changed since archiving');
    const sha = head.ChecksumSHA256 && inputChecksumType(head.ChecksumType, head.ChecksumSHA256) === 'FULL_OBJECT'
      ? Buffer.from(head.ChecksumSHA256, 'base64').toString('hex')
      : await streamedSHA256({ bucket: source.bucket, key: source.key, versionId: source.versionId, etag: source.etag, bytes: source.bytes });
    if (sha !== source.sha256) throw badRequest('Original ModelPackage artifact digest no longer matches');
  }
}
