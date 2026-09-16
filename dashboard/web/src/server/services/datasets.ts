import { datasetGuard } from '../store/dataset-references';
import { immutableFiles, versionNumber } from '../data/versions';
import { normalizeSelection, safeDataPath, type PathSelection } from '../data/selection';
import { assertConsumableObjects } from '../data/limits';
import { freezeVersionUploads, reopenVersionUploads, registerSingleUpload } from './multipart-uploads';
import { backendConfig as config } from '../backends/context';
import { runOnBackend } from '../backends/context';
import { badRequest, forbidden, HttpError, notConfigured, notFound } from '../errors';
import * as s3 from '../aws/s3';
import { getRepo } from '../store/repo';
import { assertOwner, type Session } from '../auth/session';
import type { Dataset, DatasetVersion } from '../store/types';
import { randomUUID } from 'node:crypto';
import { snapshotPrefix } from '../storage/snapshots';
import type { Project } from '../auth/projects';

const NAME_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

export function dataBucket(): string {
  const b = config().eks?.dataBucket;
  if (!b) throw notConfigured('HyperPod EKS data bucket');
  return b;
}

/** Canonical S3 prefix for a dataset version; FSx DRA auto-imports it under /fsx/datasets/<name>/v<N>. */
export function versionPrefix(name: string, version: number): string {
  return `datasets/${name}/v${version}/`;
}

export async function createDataset(input: { name: string; description?: string; tags?: string[]; format?: string }, owner: string, project?: Project, ownerSubject?: string): Promise<Dataset> {
  if (!NAME_RE.test(input.name) || input.name.length > 60) throw badRequest('name must be lowercase DNS-1123 (a-z, 0-9, -)');
  const repo = getRepo();
  if (await repo.getDataset(input.name)) throw badRequest(`dataset ${input.name} already exists`);
  const now = new Date().toISOString();
  const ds: Dataset = { name: input.name, description: input.description, owner, ownerSubject, projectId: project?.id, tags: input.tags ?? [], latestVersion: 0, createdAt: now, updatedAt: now, format: input.format };
  if (!await repo.kv.put({ pk: `DS#${ds.name}`, sk: 'META', gsi1pk: 'TYPE#DS', gsi1sk: `${now}#${ds.name}`, ...ds }, 'not_exists')) throw badRequest('dataset already exists');
  return ds;
}

export interface NewVersionInput extends PathSelection {
  /** Register an existing S3 prefix (s3://bucket/prefix/) instead of creating a fresh upload prefix. */
  uri?: string;
  note?: string;
  tags?: string[];
}

export async function createVersion(name: string, input: NewVersionInput, actor: string): Promise<DatasetVersion> {
  const repo = getRepo();
  const ds = await repo.getDataset(name);
  if (!ds) throw notFound(`dataset ${name}`);
  const now = new Date().toISOString();
  const uploadId = randomUUID();
  let uri: string;
  if (input.uri) {
    const { bucket, key } = s3.parseS3Uri(input.uri);
    s3.assertBucket(bucket);
    uri = `s3://${bucket}/${key.replace(/\/?$/, '/')}`;
  } else {
    const bucket = process.env.DASHBOARD_ARTIFACT_BUCKET;
    if (!bucket) throw notConfigured('dashboard artifact bucket');
    const prefix = `projects/${ds.projectId ?? 'legacy'}/datasets/${name}/uploads/${uploadId}/`;
    uri = `s3://${bucket}/${prefix}`;
  }
  const selection = normalizeSelection(input);
  const draft = { selection, dataset: name, uri, projectId: ds.projectId, ownerSubject: ds.ownerSubject, state: 'PENDING' as const, tags: input.tags ?? [], createdAt: now, createdBy: actor, note: input.note, versionRevision: 0, imported: Boolean(input.uri) };
  const v = await repo.publishDatasetVersion(ds, draft, `upload:${uploadId}`);
  if (input.uri) await queueFinalization(name, v.version);
  return v;
}

export async function uploadUrl(name: string, version: number, filename: string, contentType?: string): Promise<{ url: string; key: string }> {
  const repo = getRepo();
  const v = await repo.getVersion(name, version);
  if (!v) throw notFound(`dataset ${name} v${version}`);
  if (v.state !== 'PENDING' || (v as UploadVersion).imported) throw badRequest('Committed or imported versions are immutable. Create a new upload version.');
  const { bucket, key } = s3.parseS3Uri(v.uri);
  const safe = filename;
  if (!safeDataPath(safe) || Buffer.byteLength(key + safe) > 1024) throw badRequest('Invalid relative filename for an immutable runtime dataset');
  const fullKey = `${key}${safe}`;
  await registerSingleUpload(name, version, safe, bucket, fullKey, repo);
  return { url: await s3.presignPut(bucket, fullKey, contentType), key: fullKey };
}

export async function listFiles(name: string, version: number, sub = '', token?: string) {
  version = versionNumber(version);
  const repo = getRepo();
  const v = await repo.getVersion(name, version);
  const ds = await repo.getDataset(name);
  if (!ds || !v || (ds.projectId ?? '') !== (v.projectId ?? '')) throw notFound(`dataset ${name} v${version}`);
  if (v.state === 'READY') return immutableFiles(repo, name, version, sub, token);
  if (v.state !== 'PENDING') throw badRequest('This legacy version has no verified immutable browser; publish a new version');
  const { bucket, key } = s3.parseS3Uri(v.uri);
  if (sub.startsWith(key)) sub = sub.slice(key.length);
  if (sub.startsWith('/') || sub.includes('..') || sub.includes('\\')) throw badRequest('Invalid dataset subdirectory');
  return s3.list(bucket, key + sub, token);
}

export async function refreshSize(name: string, version: number): Promise<DatasetVersion> {
  const repo = getRepo();
  const v = await repo.getVersion(name, version);
  if (!v) throw notFound(`dataset ${name} v${version}`);
  if (v.state === 'PENDING') {
    await queueFinalization(name, version);
    return { ...v, finalizationRequested: true };
  }
  if (v.state === 'READY') return v;
  const { bucket, key } = s3.parseS3Uri(v.uri);
  const size = await s3.prefixSize(bucket, key);
  const updated = { ...v, sizeBytes: size.bytes, objectCount: size.objects };
  await repo.putVersion(updated);
  return updated;
}

export async function setVersionTags(name: string, version: number, tags: string[]): Promise<DatasetVersion> {
  const repo = getRepo();
  for (let attempt = 0; attempt < 8; attempt++) {
    const v = await repo.getVersion(name, version) as UploadVersion | undefined;
    if (!v) throw notFound(`dataset ${name} v${version}`);
    const updated = { ...v, tags, versionRevision: (v.versionRevision ?? 0) + 1 };
    const equals: Record<string, unknown> = { uri: v.uri };
    if (v.versionRevision !== undefined) equals.versionRevision = v.versionRevision;
    if (v.state) equals.state = v.state;
    if (await repo.kv.transaction([{ kind: 'put', item: { pk: `DS#${name}`, sk: `V#${String(version).padStart(6, '0')}`, ...updated }, condition: { equals } }])) return updated;
  }
  throw badRequest('Version metadata changed concurrently; retry');
}

export async function deleteDataset(name: string, purge: boolean): Promise<void> {
  const repo = getRepo();
  const ds = await repo.getDataset(name);
  if (!ds) return;
  // Immutable versions are retained; metadata deletion is a guarded tombstone.
  if (purge) throw badRequest('Archive purge is disabled for immutable versions; use the version retention policy');
  await repo.deleteDataset(name);
}

interface UploadVersion extends DatasetVersion { versionRevision?: number; imported?: boolean; finalizationError?: string }
async function queueFinalization(name: string, version: number) {
  const repo = getRepo();
  const v = await repo.getVersion(name, version);
  if (!v || v.state !== 'PENDING') throw badRequest('Only pending versions can be finalized');
  const { bucket, key } = s3.parseS3Uri(v.uri);
  await freezeVersionUploads(name, version, repo);
  try {
    const files = await s3.listAll(bucket, key, 1);
    if (!files.some((file) => !file.key.endsWith('/'))) throw badRequest('Upload data files before finalizing the version');
    for (const record of await repo.kv.query(`DS#${name}`, `UPLOAD#${version}#`)) {
      if (record.mode === 'MULTIPART' && record.state === 'ABORTED') continue;
      if (record.mode === 'MULTIPART' && record.state !== 'COMPLETED') throw badRequest('Complete or abort unfinished multipart uploads first');
      await s3.headObject(String(record.bucket), String(record.key));
    }
  } catch (error) { await reopenVersionUploads(name, version, repo); throw error; }
  await repo.kv.put({
    pk: `DS#${name}`, sk: `FINALIZE#${version}`, dataset: name, version,
    gsi1pk: 'TYPE#DATASET_FINALIZATION', gsi1sk: `${Date.now()}#${name}#${version}`,
  });
}

/** Called by the separate worker; publication never blocks a browser request. */
export async function finalizePendingVersions(signal?: AbortSignal) {
  const repo = getRepo();
  const requests = await repo.kv.queryGsi1('TYPE#DATASET_FINALIZATION', { limit: 10 });
  for (const request of requests) {
    if (signal?.aborted) return;
    const name = String(request.dataset);
    const version = Number(request.version);
    const v = await repo.getVersion(name, version) as UploadVersion | undefined;
    if (!v || v.state === 'READY' || !await repo.getDataset(name)) { await repo.kv.del(request.pk, request.sk); continue; }
    try {
      const project = v.projectId ? await repo.kv.get(`PROJECT#${v.projectId}`, 'META') : undefined;
      await runOnBackend({ backendId: project?.backendId as string | undefined, backendConfigHash: project?.backendConfigHash as string | undefined }, async () => {
      const bucket = process.env.DASHBOARD_ARTIFACT_BUCKET;
      if (!bucket) throw notConfigured('dashboard artifact bucket');
      await freezeVersionUploads(name, version, repo);
      const guard = await datasetGuard(repo.kv, name);
      const source = s3.parseS3Uri(v.uri);
      const registrations = await repo.kv.query(`DS#${name}`, `UPLOAD#${version}#`);
      for (const registration of registrations) {
        if (registration.mode === 'MULTIPART' && registration.state === 'ABORTED') continue;
        if (registration.mode === 'MULTIPART' && registration.state !== 'COMPLETED') throw badRequest('Complete or abort unfinished multipart uploads first');
        await s3.headObject(String(registration.bucket), String(registration.key));
      }
      const prefix = `projects/${v.projectId ?? 'legacy'}/datasets/${name}/versions/v${version}/`;
      const snapshot = await snapshotPrefix({
        sourceBucket: source.bucket, sourcePrefix: source.key, targetBucket: bucket,
        targetPrefix: prefix, identity: `dataset:${name}:v${version}`, selection: v.selection, signal,
      });
      const current = await repo.getVersion(name, version) as UploadVersion;
      const updated = {
        ...current, hydrationBytes: assertConsumableObjects(snapshot.manifest.objects), uri: `s3://${bucket}/${prefix}`, state: 'READY' as const,
        fsxPath: `/fsx/datasets/projects/${v.projectId ?? 'legacy'}/${name}/v${version}`,
        manifestUri: `s3://${bucket}/${prefix}manifest.json`, manifestHash: snapshot.hash, manifestVersionId: snapshot.manifestVersionId,
        verifiedAt: snapshot.manifest.createdAt, objectCount: snapshot.manifest.objects.length,
        sizeBytes: snapshot.manifest.objects.reduce((sum, file) => sum + file.bytes, 0),
        versionRevision: (current.versionRevision ?? 0) + 1, finalizationError: undefined,
      };
      const done = await repo.kv.transaction([
        { kind: 'check', pk: guard.pk, sk: guard.sk, condition: { equals: { state: 'ACTIVE' } } },
        { kind: 'put', item: { pk: `DS#${name}`, sk: `V#${String(version).padStart(6, '0')}`, ...updated }, condition: { equals: { state: 'PENDING', uri: v.uri, versionRevision: current.versionRevision ?? 0 } } },
        { kind: 'delete', pk: request.pk, sk: request.sk },
      ]);
      if (!done && (await repo.getVersion(name, version))?.state !== 'READY') throw new Error('Version changed while finalizing; retry');
      }, repo, () => new Date(), 'observe');
    } catch (error) {
      // Keep the upload set frozen: an immutable snapshot may already exist after an ambiguous reply.
      console.error('[dataset] finalization failed', name, version, (error as Error).name);
      const current = await repo.getVersion(name, version) as UploadVersion | undefined;
      if (current?.state === 'PENDING') {
        await repo.kv.transaction([{
          kind: 'put',
          item: { pk: `DS#${name}`, sk: `V#${String(version).padStart(6, '0')}`, ...current, finalizationError: (error as Error).message.slice(0, 500), versionRevision: (current.versionRevision ?? 0) + 1 },
          condition: { equals: { uri: current.uri, state: 'PENDING', versionRevision: current.versionRevision ?? 0 } },
        }, ...(error instanceof HttpError && error.status >= 400 && error.status < 500 ? [{
          kind: 'delete' as const, pk: request.pk, sk: request.sk,
          condition: { equals: { gsi1sk: request.gsi1sk } },
        }] : [])]);
      }
    }
  }
}

/** Lineage: which workflows consumed or produced this dataset. */
export async function lineage(name: string) {
  return getRepo().datasetLineage(name);
}

/** Datasets are writable by their owner or an admin; everyone can read. */
export async function assertDatasetOwner(session: Session, name: string): Promise<void> {
  const ds = await getRepo().getDataset(name);
  if (!ds) throw notFound(`dataset ${name}`);
  if (ds.ownerSubject) {
    if (session.role === 'admin' || ds.ownerSubject === session.subject) return;
    throw forbidden('Only the dataset owner or an administrator can modify it');
  }
  assertOwner(session, ds.owner, 'dataset');
}
