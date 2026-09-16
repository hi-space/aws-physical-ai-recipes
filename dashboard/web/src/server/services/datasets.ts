import { config } from '../config';
import { badRequest, notConfigured, notFound } from '../errors';
import * as s3 from '../aws/s3';
import { getRepo } from '../store/repo';
import { assertOwner, type Session } from '../auth/session';
import type { Dataset, DatasetVersion } from '../store/types';

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

export async function createDataset(input: { name: string; description?: string; tags?: string[]; format?: string }, owner: string): Promise<Dataset> {
  if (!NAME_RE.test(input.name) || input.name.length > 60) throw badRequest('name must be lowercase DNS-1123 (a-z, 0-9, -)');
  const repo = getRepo();
  if (await repo.getDataset(input.name)) throw badRequest(`dataset ${input.name} already exists`);
  const now = new Date().toISOString();
  const ds: Dataset = { name: input.name, description: input.description, owner, tags: input.tags ?? [], latestVersion: 0, createdAt: now, updatedAt: now, format: input.format };
  await repo.putDataset(ds);
  return ds;
}

export interface NewVersionInput {
  /** Register an existing S3 prefix (s3://bucket/prefix/) instead of creating a fresh upload prefix. */
  uri?: string;
  note?: string;
  tags?: string[];
}

export async function createVersion(name: string, input: NewVersionInput, actor: string): Promise<DatasetVersion> {
  const repo = getRepo();
  const ds = await repo.getDataset(name);
  if (!ds) throw notFound(`dataset ${name}`);
  const version = ds.latestVersion + 1;
  const now = new Date().toISOString();
  let uri: string;
  let fsxPath: string | undefined;
  if (input.uri) {
    const { bucket, key } = s3.parseS3Uri(input.uri);
    s3.assertBucket(bucket);
    uri = `s3://${bucket}/${key.replace(/\/?$/, '/')}`;
    if (bucket === config().eks?.dataBucket) {
      const m = /^(datasets|checkpoints)\/(.*)$/.exec(key.replace(/\/$/, ''));
      if (m) fsxPath = `/fsx/${m[1]}/${m[2]}`;
    }
  } else {
    const bucket = dataBucket();
    const prefix = versionPrefix(name, version);
    uri = `s3://${bucket}/${prefix}`;
    fsxPath = `/fsx/datasets/${name}/v${version}`;
    await s3.putText(bucket, `${prefix}.dataset.json`, JSON.stringify({ dataset: name, version, createdBy: actor, createdAt: now, note: input.note ?? '' }, null, 2));
  }
  const v: DatasetVersion = { dataset: name, version, uri, fsxPath, tags: input.tags ?? [], createdAt: now, createdBy: actor, note: input.note };
  await repo.putVersion(v);
  await repo.putDataset({ ...ds, latestVersion: version, updatedAt: now });
  return v;
}

export async function uploadUrl(name: string, version: number, filename: string, contentType?: string): Promise<{ url: string; key: string }> {
  const repo = getRepo();
  const v = await repo.getVersion(name, version);
  if (!v) throw notFound(`dataset ${name} v${version}`);
  const { bucket, key } = s3.parseS3Uri(v.uri);
  const safe = filename.replace(/^\/+/, '').replace(/\.\./g, '');
  if (!safe) throw badRequest('filename required');
  const fullKey = `${key}${safe}`;
  return { url: await s3.presignPut(bucket, fullKey, contentType), key: fullKey };
}

export async function listFiles(name: string, version: number, sub = '', token?: string) {
  const v = await getRepo().getVersion(name, version);
  if (!v) throw notFound(`dataset ${name} v${version}`);
  const { bucket, key } = s3.parseS3Uri(v.uri);
  return s3.list(bucket, key + sub, token);
}

export async function refreshSize(name: string, version: number): Promise<DatasetVersion> {
  const repo = getRepo();
  const v = await repo.getVersion(name, version);
  if (!v) throw notFound(`dataset ${name} v${version}`);
  const { bucket, key } = s3.parseS3Uri(v.uri);
  const size = await s3.prefixSize(bucket, key);
  const updated = { ...v, sizeBytes: size.bytes, objectCount: size.objects };
  await repo.putVersion(updated);
  return updated;
}

export async function setVersionTags(name: string, version: number, tags: string[]): Promise<DatasetVersion> {
  const repo = getRepo();
  const v = await repo.getVersion(name, version);
  if (!v) throw notFound(`dataset ${name} v${version}`);
  const updated = { ...v, tags };
  await repo.putVersion(updated);
  return updated;
}

export async function deleteDataset(name: string, purge: boolean): Promise<void> {
  const repo = getRepo();
  const ds = await repo.getDataset(name);
  if (!ds) return;
  if (purge) {
    for (const v of await repo.listVersions(name)) {
      const { bucket, key } = s3.parseS3Uri(v.uri);
      if (key.startsWith(`datasets/${name}/`)) await s3.deletePrefix(bucket, key);
    }
  }
  await repo.deleteDataset(name);
}

/** Lineage: which workflows consumed or produced this dataset. */
export async function lineage(name: string) {
  const repo = getRepo();
  const versions = await repo.listVersions(name);
  const produced = versions.filter((v) => v.producedBy).map((v) => ({ version: v.version, ...v.producedBy! }));
  const consumers: { workflowId: string; workflowName: string; task: string; version: 'latest' | number; status: string }[] = [];
  for (const wf of await repo.listWorkflows({ limit: 200 })) {
    for (const t of wf.spec.workflow.tasks) {
      for (const i of t.inputs) {
        if ('dataset' in i && i.dataset.name === name) consumers.push({ workflowId: wf.id, workflowName: wf.name, task: t.name, version: i.dataset.version, status: wf.status });
      }
    }
  }
  return { produced, consumers };
}

/** Datasets are writable by their owner or an admin; everyone can read. */
export async function assertDatasetOwner(session: Session, name: string): Promise<void> {
  const ds = await getRepo().getDataset(name);
  if (!ds) throw notFound(`dataset ${name}`);
  assertOwner(session, ds.owner, 'dataset');
}
