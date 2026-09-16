import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { s3 } from '../aws/clients';
import { badRequest } from '../errors';
import type { ObjectMetadata, ObjectReference, ObjectStorage } from './evidence';

/** Read-only adapter. Constructing it performs no AWS call. */
export class S3EvidenceStorage implements ObjectStorage {
  async head(ref: ObjectReference): Promise<ObjectMetadata> {
    const result = await s3().send(new HeadObjectCommand({
      Bucket: ref.bucket, Key: ref.key, VersionId: ref.versionId, ChecksumMode: 'ENABLED',
    }));
    return { versionId: result.VersionId, bytes: result.ContentLength ?? -1,
      checksumSHA256: result.ChecksumSHA256, checksumType: result.ChecksumType };
  }
  async get(ref: ObjectReference & { versionId: string }, maximumBytes: number) {
    const result = await s3().send(new GetObjectCommand({
      Bucket: ref.bucket, Key: ref.key, VersionId: ref.versionId, ChecksumMode: 'ENABLED',
    }));
    const stream = result.Body as AsyncIterable<Uint8Array> & { destroy?: () => void } | undefined;
    try {
      if (!stream || (result.ContentLength ?? Infinity) > maximumBytes) throw badRequest('Evidence object exceeds its read limit');
      let length = 0;
      const chunks: Uint8Array[] = [];
      for await (const chunk of stream) {
        length += chunk.byteLength;
        if (length > maximumBytes) throw badRequest('Evidence object exceeds its read limit');
        chunks.push(chunk);
      }
      return { body: Buffer.concat(chunks), metadata: {
        versionId: result.VersionId, bytes: result.ContentLength ?? length,
        checksumSHA256: result.ChecksumSHA256, checksumType: result.ChecksumType,
      } };
    } finally { stream?.destroy?.(); }
  }
  async presign(ref: ObjectReference & { versionId: string }) {
    return getSignedUrl(s3(), new GetObjectCommand({ Bucket: ref.bucket, Key: ref.key, VersionId: ref.versionId }), { expiresIn: 300 });
  }
}
