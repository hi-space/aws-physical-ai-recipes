import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { s3 } from '../aws/clients';
import { multipartStorage, type MultipartStorage } from './multipart-storage';
export interface FileDescription {
  path: string;
  size: number;
  checksumSHA256: string;
  /** Stored transport checksum can be composite; checksumSHA256 remains full-file. */
  storageChecksumSHA256?: string;
  storageChecksumType?: 'FULL_OBJECT' | 'COMPOSITE';
}
export interface StoredManifest {
  body: string;
  versionId: string;
}
export interface ObjectStorage {
  multipart?: MultipartStorage;
  presignPut(bucket: string, key: string, file: FileDescription, expires: number, immutable?: boolean): Promise<{
    url: string;
    headers: Record<string, string>;
  }>;
  head(bucket: string, key: string, versionId?: string, signal?: AbortSignal): Promise<{
    versionId: string;
    size: number;
    checksumSHA256: string;
    checksumType?: 'FULL_OBJECT' | 'COMPOSITE';
    metadata?: Record<string, string>;
  }>;
  readManifest(bucket: string, key: string, signal?: AbortSignal, versionId?: string): Promise<StoredManifest | undefined>;
  writeManifest(bucket: string, key: string, body: string, signal?: AbortSignal): Promise<StoredManifest>;
  presignGet(bucket: string, key: string, versionId: string, expires: number): Promise<string>;
}
export const objectStorage: ObjectStorage = {
  multipart: multipartStorage,
  async presignPut(bucket, key, file, expires, immutable) {
    const url = await getSignedUrl(s3(), new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentLength: file.size,
      ContentType: 'application/octet-stream',
      ChecksumSHA256: file.checksumSHA256,
      ...(immutable ? { IfNoneMatch: '*' } : {}),
    }), {
      expiresIn: expires,
      unhoistableHeaders: new Set(['x-amz-checksum-sha256'])
    });
    return {
      url,
      headers: {
        'x-amz-checksum-sha256': file.checksumSHA256,
        'content-type': 'application/octet-stream',
        ...(immutable ? { 'if-none-match': '*' } : {}),
      }
    };
  },
  async head(bucket, key, versionId, signal) {
    const response = await s3().send(new HeadObjectCommand({
      Bucket: bucket,
      Key: key,
      VersionId: versionId,
      ChecksumMode: 'ENABLED'
    }), {
      abortSignal: signal
    });
    if (!response.VersionId || response.VersionId === 'null' || !response.ChecksumSHA256 || response.ContentLength === undefined) throw new Error('Object has no verified immutable SHA256 version');
    return {
      versionId: response.VersionId,
      size: response.ContentLength,
      checksumSHA256: response.ChecksumSHA256,
      checksumType: response.ChecksumType ?? (response.ChecksumSHA256.includes('-') ? 'COMPOSITE' : 'FULL_OBJECT'),
      metadata: response.Metadata,
    };
  },
  async readManifest(bucket, key, signal, versionId) {
    try {
      const response = await s3().send(new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        VersionId: versionId,
      }), {
        abortSignal: signal
      });
      if (!response.VersionId || response.VersionId === 'null' || !response.Body || (response.ContentLength ?? 0) > 2 * 1024 * 1024) throw new Error('Manifest is not a bounded immutable version');
      if (versionId && response.VersionId !== versionId) throw new Error('Pinned manifest version mismatch');
      const body = await response.Body.transformToString();
      if (Buffer.byteLength(body) > 2 * 1024 * 1024) throw new Error('Manifest exceeds size limit');
      return {
        body,
        versionId: response.VersionId
      };
    } catch (error) {
      if (['NoSuchKey', 'NotFound'].includes((error as Error).name)) return;
      throw error;
    }
  },
  async writeManifest(bucket, key, body, signal) {
    try {
      const response = await s3().send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: 'application/json',
        ChecksumAlgorithm: 'SHA256',
        IfNoneMatch: '*'
      }), {
        abortSignal: signal
      });
      if (!response.VersionId || response.VersionId === 'null') throw new Error('Versioned artifact bucket is required');
      return {
        body,
        versionId: response.VersionId
      };
    } catch (error) {
      if ((error as {
        name?: string;
      }).name !== 'PreconditionFailed') throw error;
      const existing = await objectStorage.readManifest(bucket, key, signal);
      if (!existing) throw error;
      return existing;
    }
  },
  presignGet(bucket, key, versionId, expires) {
    return getSignedUrl(s3(), new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      VersionId: versionId
    }), {
      expiresIn: expires
    });
  }
};
