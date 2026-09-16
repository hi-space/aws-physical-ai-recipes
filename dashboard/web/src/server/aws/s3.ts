import { DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { backendConfig as config } from '../backends/context';
import { badRequest } from '../errors';
import { s3 } from './clients';

export interface S3Entry { key: string; name: string; size?: number; lastModified?: string; isPrefix: boolean }
export interface S3Listing { bucket: string; prefix: string; entries: S3Entry[]; nextToken?: string }

/** Buckets the dashboard is allowed to touch (discovered from sibling stacks). */
export function allowedBuckets(): { name: string; label: string }[] {
  const c = config();
  const out: { name: string; label: string }[] = [];
  if (process.env.DASHBOARD_ARTIFACT_BUCKET) out.push({ name: process.env.DASHBOARD_ARTIFACT_BUCKET, label: '연구 데이터·버전별 결과' });
  if (c.eks?.dataBucket) out.push({ name: c.eks.dataBucket, label: 'HyperPod EKS data (FSx mirror)' });
  if (c.groot?.artifactsBucket) out.push({ name: c.groot.artifactsBucket, label: 'GR00T artifacts (SageMaker)' });
  if (c.slurm?.dataBucket) out.push({ name: c.slurm.dataBucket, label: 'HyperPod Slurm data' });
  return out;
}
export async function headObject(bucket: string, key: string) {
  assertBucket(bucket);
  return s3().send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
}
export function assertBucket(bucket: string): void {
  if (!allowedBuckets().some((b) => b.name === bucket)) throw badRequest(`Bucket ${bucket} is not managed by this dashboard`);
}

export async function list(bucket: string, prefix: string, token?: string, max = 200): Promise<S3Listing> {
  assertBucket(bucket);
  const out = await s3().send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, Delimiter: '/', ContinuationToken: token, MaxKeys: max }));
  const entries: S3Entry[] = [];
  for (const p of out.CommonPrefixes ?? []) entries.push({ key: p.Prefix!, name: p.Prefix!.slice(prefix.length).replace(/\/$/, ''), isPrefix: true });
  for (const o of out.Contents ?? []) {
    if (o.Key === prefix) continue;
    entries.push({ key: o.Key!, name: o.Key!.slice(prefix.length), size: o.Size, lastModified: o.LastModified?.toISOString(), isPrefix: false });
  }
  return { bucket, prefix, entries, nextToken: out.NextContinuationToken };
}

/** Recursively list keys under a prefix (bounded). */
export async function listAll(bucket: string, prefix: string, limit = 5000): Promise<{ key: string; size: number; lastModified?: string }[]> {
  assertBucket(bucket);
  const keys: { key: string; size: number; lastModified?: string }[] = [];
  let token: string | undefined;
  do {
    const out = await s3().send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token, MaxKeys: 1000 }));
    for (const o of out.Contents ?? []) keys.push({ key: o.Key!, size: o.Size ?? 0, lastModified: o.LastModified?.toISOString() });
    token = out.NextContinuationToken;
  } while (token && keys.length < limit);
  return keys;
}

export async function prefixSize(bucket: string, prefix: string): Promise<{ bytes: number; objects: number }> {
  const all = await listAll(bucket, prefix, 20000);
  return { bytes: all.reduce((a, b) => a + b.size, 0), objects: all.length };
}

export async function presignGet(bucket: string, key: string, expires = 900): Promise<string> {
  assertBucket(bucket);
  return getSignedUrl(s3(), new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: expires });
}
export async function presignPut(bucket: string, key: string, contentType?: string, expires = 3600): Promise<string> {
  assertBucket(bucket);
  return getSignedUrl(s3(), new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType }), { expiresIn: expires });
}
export async function putText(bucket: string, key: string, body: string, contentType = 'application/json'): Promise<void> {
  assertBucket(bucket);
  await s3().send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
}
export async function getText(bucket: string, key: string): Promise<string> {
  assertBucket(bucket);
  const out = await s3().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return (await out.Body?.transformToString()) ?? '';
}
export async function deleteKeys(bucket: string, keys: string[]): Promise<void> {
  assertBucket(bucket);
  for (let i = 0; i < keys.length; i += 1000) {
    await s3().send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })) } }));
  }
}
export async function deletePrefix(bucket: string, prefix: string): Promise<number> {
  const all = await listAll(bucket, prefix, 50000);
  await deleteKeys(bucket, all.map((k) => k.key));
  return all.length;
}

export function parseS3Uri(uri: string): { bucket: string; key: string } {
  const m = /^s3:\/\/([^/]+)\/?(.*)$/.exec(uri);
  if (!m) throw badRequest(`Invalid S3 URI ${uri}`);
  return { bucket: m[1], key: m[2] };
}
