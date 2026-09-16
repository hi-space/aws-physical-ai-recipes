import { createHash } from 'node:crypto';
import {
  AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand,
  DeleteObjectCommand, GetObjectCommand, ListMultipartUploadsCommand, ListPartsCommand, UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { s3 } from '../aws/clients';

export interface StoredPart { number: number; size: number; etag: string; checksumSHA256: string }
export interface MultipartStorage {
  create(bucket: string, key: string, identity: string, sha256: string, signal?: AbortSignal): Promise<string>;
  uploads(bucket: string, key: string, signal?: AbortSignal): Promise<string[]>;
  parts(bucket: string, key: string, uploadId: string, signal?: AbortSignal, number?: number): Promise<StoredPart[]>;
  sign(bucket: string, key: string, uploadId: string, part: Omit<StoredPart, 'etag'>): Promise<{ url: string; headers: Record<string, string> }>;
  complete(bucket: string, key: string, uploadId: string, parts: StoredPart[], composite: string, signal?: AbortSignal): Promise<void>;
  abort(bucket: string, key: string, uploadId: string, signal?: AbortSignal): Promise<void>;
  deleteVersion(bucket: string, key: string, version: string, signal?: AbortSignal): Promise<void>;
  sha256(bucket: string, key: string, version: string, size: number, signal: AbortSignal, check: () => Promise<void>): Promise<string>;
}
function bounded(signal?: AbortSignal) {
  return { abortSignal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000) };
}
export const multipartStorage: MultipartStorage = {
  async create(bucket, key, identity, sha256, signal) {
    const result = await s3().send(new CreateMultipartUploadCommand({
      Bucket: bucket, Key: key, ContentType: 'application/octet-stream',
      ChecksumAlgorithm: 'SHA256', ChecksumType: 'COMPOSITE',
      Metadata: { 'pai-checkpoint-file': identity, 'pai-full-sha256': sha256 },
    }), bounded(signal));
    if (!result.UploadId) throw new Error('Missing multipart upload identity');
    return result.UploadId;
  },
  async uploads(bucket, key, signal) {
    const ids: string[] = [];
    let KeyMarker: string | undefined, UploadIdMarker: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < 20; page++) {
      const result = await s3().send(new ListMultipartUploadsCommand({
        Bucket: bucket, Prefix: key, KeyMarker, UploadIdMarker, MaxUploads: 1000,
      }), bounded(signal));
      for (const upload of result.Uploads ?? []) if (upload.Key === key && upload.UploadId) ids.push(upload.UploadId);
      if (!result.IsTruncated) return ids;
      const cursor = JSON.stringify([result.NextKeyMarker, result.NextUploadIdMarker]);
      if (!result.NextKeyMarker || seen.has(cursor)) throw new Error('Invalid multipart listing cursor');
      seen.add(cursor);
      KeyMarker = result.NextKeyMarker; UploadIdMarker = result.NextUploadIdMarker;
    }
    throw new Error('Multipart listing exceeds bounded cleanup limit');
  },
  async parts(bucket, key, uploadId, signal, number) {
    const parts: StoredPart[] = [];
    let marker: string | undefined = number === undefined ? undefined : String(number - 1);
    const seen = new Set<string>();
    for (let page = 0; page < 11; page++) {
      const result = await s3().send(new ListPartsCommand({
        Bucket: bucket, Key: key, UploadId: uploadId, PartNumberMarker: marker, MaxParts: number === undefined ? 1000 : 1,
      }), bounded(signal));
      for (const part of result.Parts ?? []) {
        if (!part.PartNumber || part.Size === undefined || !part.ETag || !part.ChecksumSHA256) throw new Error('Multipart part has no verified identity');
        parts.push({ number: part.PartNumber, size: part.Size, etag: part.ETag, checksumSHA256: part.ChecksumSHA256 });
      }
      if (parts.length > 10_000) throw new Error('Multipart part count exceeds limit');
      if (number !== undefined) return parts.filter(part => part.number === number);
      if (!result.IsTruncated) return parts;
      const next = result.NextPartNumberMarker;
      if (!next || seen.has(next)) throw new Error('Invalid part listing cursor');
      seen.add(next); marker = next;
    }
    throw new Error('Multipart part listing exceeds limit');
  },
  async sign(bucket, key, uploadId, part) {
    return {
      url: await getSignedUrl(s3(), new UploadPartCommand({
        Bucket: bucket, Key: key, UploadId: uploadId, PartNumber: part.number,
        ContentLength: part.size, ChecksumSHA256: part.checksumSHA256,
      }), { expiresIn: 300, unhoistableHeaders: new Set(['x-amz-checksum-sha256']) }),
      headers: { 'x-amz-checksum-sha256': part.checksumSHA256 },
    };
  },
  async complete(bucket, key, uploadId, parts, composite, signal) {
    await s3().send(new CompleteMultipartUploadCommand({
      Bucket: bucket, Key: key, UploadId: uploadId, IfNoneMatch: '*',
      ChecksumType: 'COMPOSITE', ChecksumSHA256: composite,
      MultipartUpload: { Parts: parts.map(part => ({ PartNumber: part.number, ETag: part.etag, ChecksumSHA256: part.checksumSHA256 })) },
    }), bounded(signal));
  },
  async abort(bucket, key, uploadId, signal) {
    try { await s3().send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }), bounded(signal)); }
    catch (error) { if ((error as Error).name !== 'NoSuchUpload') throw error; }
  },
  async deleteVersion(bucket, key, version, signal) {
    await s3().send(new DeleteObjectCommand({ Bucket: bucket, Key: key, VersionId: version }), bounded(signal));
  },
  async sha256(bucket, key, version, size, signal, check) {
    const timeout = AbortSignal.timeout(6 * 60 * 60_000);
    const guard = new AbortController();
    const combined = AbortSignal.any([signal, timeout, guard.signal]);
    const result = await s3().send(new GetObjectCommand({ Bucket: bucket, Key: key, VersionId: version }),
      { abortSignal: combined });
    const body = result.Body as (AsyncIterable<Uint8Array> & { destroy?: () => void }) | undefined;
    if (!body || result.VersionId !== version || result.ContentLength !== size) {
      body?.destroy?.(); throw new Error('Full checksum verification version or size mismatch');
    }
    const hash = createHash('sha256');
    let count = 0, checking: Promise<void> | undefined;
    const abort = () => body.destroy?.();
    combined.addEventListener('abort', abort, { once: true });
    if (combined.aborted) abort();
    const timer = setInterval(() => {
      if (!checking) checking = check().catch(error => { guard.abort(error); }).finally(() => { checking = undefined; });
    }, 5_000);
    timer.unref();
    try {
      combined.throwIfAborted();
      await check();
      for await (const bytes of body) {
        combined.throwIfAborted();
        count += bytes.byteLength;
        if (count > size) throw new Error('Full checksum verification exceeds declared size');
        hash.update(bytes);
      }
      if (count !== size) throw new Error('Full checksum verification was truncated');
      await check();
      return hash.digest('base64');
    } catch (error) { combined.throwIfAborted(); throw error; }
    finally {
      clearInterval(timer);
      combined.removeEventListener('abort', abort);
      body.destroy?.();
      if (checking) await checking;
    }
  },
};
