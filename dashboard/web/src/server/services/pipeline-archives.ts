import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { resolveProject } from '../auth/projects';
import { requireRole, type Session } from '../auth/session';
import { badRequest, forbidden, HttpError, notFound } from '../errors';
import { Repo, getRepo } from '../store/repo';
import type { Item } from '../store/dynamo';
import { datasetGuard } from '../store/dataset-references';
import { assertConsumableObjects } from '../data/limits';
import { digest } from '../evaluations/evidence';
import { SageMakerSources, sageMakerSources, retainSelectiveExecutionSources } from '../evaluations/sagemaker-source';
import { S3PipelineArchiveStorage, type PipelineArchiveStorage } from '../evaluations/pipeline-storage';
import { pipelineArchiveKey, pipelineExecutionKey, type PipelineArchiveRecord, type PipelineDatasetVersion, type PipelineProvenance } from '../evaluations/pipeline-types';
import type { DatasetVersion } from '../store/types';

const id = z.string().regex(/^[a-f0-9]{32}$/);
const step = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
export const archiveRequestSchema = z.object({
  trainingStep: step, reportSteps: z.array(step).max(10).default([]),
}).strict();
interface Dependencies {
  repo: Repo; sources: SageMakerSources; storage: PipelineArchiveStorage; now?: () => Date;
}
const clean = (row: Item): PipelineArchiveRecord => {
  const { pk: _pk, sk: _sk, gsi1pk: _gsi, gsi1sk: _sort, ...value } = row;
  return value as unknown as PipelineArchiveRecord;
};
function item(record: PipelineArchiveRecord): Item {
  return { ...pipelineArchiveKey(record.projectId, record.id), ...record,
    gsi1pk: ['PENDING', 'ARCHIVING'].includes(record.status) ? 'TYPE#PIPELINE_ARCHIVE' : 'TYPE#PIPELINE_ARCHIVE_HISTORY',
    gsi1sk: `${record.createdAt}#${record.id}` };
}
const principal = (session: Session) => session.subject ?? session.user;
function immutableProvenance(value: PipelineProvenance) {
  if (!value.package) return value;
  const { observedApprovalStatus: _mutableStatus, ...identity } = value.package;
  return { ...value, package: identity };
}

export async function archivedPublication(repo: Repo, projectId: string, version: DatasetVersion) {
  const archiveId = (version as PipelineDatasetVersion).pipelineArchiveId;
  if (!id.safeParse(archiveId).success) throw badRequest('Dataset has no trusted pipeline producer');
  const row = await repo.kv.get(pipelineArchiveKey(projectId, archiveId).pk, 'META');
  if (!row || row.projectId !== projectId) throw notFound('pipeline archive');
  const archive = clean(row), pin = archive.dataset;
  const execution = await repo.kv.get(pipelineExecutionKey(archive.executionArn).pk, 'META');
  if (!execution || execution.projectId !== projectId || archive.id !== archiveId || archive.status !== 'READY' ||
      !archive.provenance || archive.provenance.executionArn !== archive.executionArn || !archive.sourceObject ||
      !pin || archive.datasetName !== version.dataset || archive.version !== version.version ||
      pin.uri !== version.uri || pin.manifestHash !== version.manifestHash || pin.manifestUri !== version.manifestUri ||
      pin.manifestVersionId !== version.manifestVersionId ||
      version.state !== 'READY' || version.projectId !== projectId) throw badRequest('Pipeline archive publication provenance does not match');
  return archive;
}

/** Queues copies of already completed artifacts. Never starts a training job. */
export class PipelineArchives {
  constructor(private readonly d: Dependencies) {}
  private now() { return (this.d.now?.() ?? new Date()).toISOString(); }
  private async access(session: Session, projectId: string, write = false) {
    if (write) requireRole(session, 'researcher');
    return resolveProject(session, projectId, this.d.repo, write ? 'researcher' : 'viewer');
  }
  private async ownedExecution(projectId: string, arn: string) {
    this.d.sources.assertExecution(arn);
    const record = await this.d.repo.kv.get(pipelineExecutionKey(arn).pk, 'META');
    // No legacy admin bypass for import or approval.
    if (!record || record.projectId !== projectId || typeof record.ownerSubject !== 'string') throw forbidden('Archive requires a locally registered execution in this project');
    return record;
  }
  async list(session: Session, projectId: string, arn: string) {
    await this.access(session, projectId); await this.ownedExecution(projectId, arn);
    const rows = await this.d.repo.kv.query(`PROJECT#${projectId}`, `PIPELINE_ARCHIVE#${digest(arn)}#`);
    return Promise.all(rows.map(row => this.get(session, projectId, String(row.id))));
  }
  async get(session: Session, projectId: string, archiveId: string) {
    await this.access(session, projectId);
    if (!id.safeParse(archiveId).success) throw badRequest('Invalid archive ID');
    const row = await this.d.repo.kv.get(pipelineArchiveKey(projectId, archiveId).pk, 'META');
    if (!row || row.projectId !== projectId) throw notFound('pipeline archive');
    await this.ownedExecution(projectId, String(row.executionArn));
    return clean(row);
  }
  async request(session: Session, projectId: string, arn: string, raw: unknown) {
    await this.access(session, projectId, true); const origin = await this.ownedExecution(projectId, arn);
    const input = archiveRequestSchema.safeParse(raw);
    if (!input.success) throw badRequest('Select declared training/report steps only');
    const reports = [...new Set(input.data.reportSteps)].sort();
    if (reports.includes(input.data.trainingStep)) throw badRequest('Training step cannot also be its evaluation');
    const provenance = { ...await this.d.sources.inspect(arn, input.data.trainingStep, reports), ownerSubject: String(origin.ownerSubject) };
    await this.access(session, projectId, true); await this.ownedExecution(projectId, arn);
    const archiveId = digest(JSON.stringify([projectId, arn, input.data.trainingStep, reports])).slice(0, 32);
    const key = pipelineArchiveKey(projectId, archiveId), old = await this.d.repo.kv.get(key.pk, key.sk);
    if (old) return clean(old);
    const record: PipelineArchiveRecord = { id: archiveId, projectId, owner: session.user, ownerSubject: principal(session),
      executionArn: arn, trainingStep: input.data.trainingStep, reportSteps: reports, provenance,
      datasetName: `sm-output-${archiveId}`, status: 'PENDING', createdAt: this.now(), updatedAt: this.now() };
    await this.d.repo.kv.transaction([
      { kind: 'put', item: item(record), condition: { absent: true } },
      { kind: 'put', item: { pk: `PROJECT#${projectId}`, sk: `PIPELINE_ARCHIVE#${digest(arn)}#${archiveId}`, id: archiveId }, condition: { absent: true } },
      { kind: 'check', ...pipelineExecutionKey(arn), condition: { equals: { projectId } } },
    ]);
    return this.get(session, projectId, archiveId);
  }
  async retry(session: Session, projectId: string, archiveId: string) {
    const project = await this.access(session, projectId, true);
    const record = await this.get(session, projectId, archiveId);
    if (record.ownerSubject !== principal(session) && session.role !== 'admin' && project.members[principal(session)] !== 'project-admin') throw forbidden('Only the archive owner or project administrator may retry it');
    if (!['FAILED', 'CANCELLED'].includes(record.status)) throw badRequest('Only a failed or cancelled archive can be retried');
    const key = pipelineArchiveKey(projectId, archiveId), holder = randomUUID();
    if (!await this.d.repo.kv.acquireLease(key.pk, 'LEASE', holder, 120)) throw new HttpError(409, 'Archive cleanup is still active; retry after its lease is released');
    try {
      if (!await this.d.repo.kv.transaction([
        { kind: 'check', pk: key.pk, sk: 'LEASE', condition: { equals: { holder }, after: { expires: Math.floor(Date.now() / 1000) } } },
        { kind: 'put', item: item({ ...record, status: 'PENDING', error: undefined, updatedAt: this.now() }),
          condition: { equals: { status: record.status } } },
      ])) throw new HttpError(409, 'Archive changed before retry');
    } finally {
      await this.d.repo.kv.transaction([{ kind: 'delete', pk: key.pk, sk: 'LEASE', condition: { equals: { holder } } }]);
    }
    return this.get(session, projectId, archiveId);
  }
  async cancel(session: Session, projectId: string, archiveId: string) {
    const project = await this.access(session, projectId, true);
    const record = await this.get(session, projectId, archiveId);
    if (record.ownerSubject !== principal(session) && session.role !== 'admin' && project.members[principal(session)] !== 'project-admin') throw forbidden('Only the archive owner or project administrator may cancel it');
    if (record.status === 'READY') throw badRequest('Completed archives are immutable');
    await this.d.repo.kv.transaction([{ kind: 'put', item: item({ ...record, status: 'CANCELLED', updatedAt: this.now() }),
      condition: { equals: { status: record.status } } }]);
    return this.get(session, projectId, archiveId);
  }
  async reconcile(record: PipelineArchiveRecord, parentSignal?: AbortSignal) {
    if (parentSignal?.aborted) return;
    const key = pipelineArchiveKey(record.projectId, record.id), holder = randomUUID();
    if (!await this.d.repo.kv.acquireLease(key.pk, 'LEASE', holder, 120)) return;
    const controller = new AbortController();
    const signal = parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal;
    const check = async () => {
      signal.throwIfAborted();
      const current = await this.d.repo.kv.get(key.pk, key.sk);
      if (!current || !['PENDING', 'ARCHIVING'].includes(String(current.status))) throw badRequest('Archive was cancelled or already completed');
      await this.ownedExecution(record.projectId, record.executionArn);
      signal.throwIfAborted();
    };
    let renewal: Promise<void> | undefined;
    const timer = setInterval(() => {
      if (renewal || signal.aborted) return;
      renewal = (async () => {
        await check();
        if (!await this.d.repo.kv.acquireLease(key.pk, 'LEASE', holder, 120)) throw new Error('Archive lease lost');
      })().catch(error => controller.abort(error)).finally(() => { renewal = undefined; });
    }, 15_000);
    timer.unref();
    try {
      await check();
      const running = { ...record, status: 'ARCHIVING' as const, updatedAt: this.now() };
      if (!await this.d.repo.kv.transaction([{ kind: 'put', item: item(running), condition: { equals: { status: record.status } } }])) return;
      const origin = await this.ownedExecution(record.projectId, record.executionArn);
      const observed = { ...await this.d.sources.inspect(record.executionArn, record.trainingStep, record.reportSteps), ownerSubject: String(origin.ownerSubject) };
      if (!record.provenance) throw badRequest('Backend provenance changed after the archive request');
      const provenance = retainSelectiveExecutionSources(record.provenance, observed);
      // DynamoDB maps have no stable key order. Values and array order remain
      // exact; only Registry approval status is a mutable observation.
      if (!isDeepStrictEqual(immutableProvenance(observed), immutableProvenance(provenance))) throw badRequest('Backend provenance changed after the archive request');
      // Registry status can change independently; retain the explicitly dated
      // request observation and never promote it into a quality decision.
      await check();
      const archived = await this.d.storage.archive(provenance, record.projectId, record.id, record.createdAt, signal);
      await check();
      const { manifest, manifestPin } = archived, name = record.datasetName;
      if (manifest.identity !== `pipeline:${record.id}` || !manifestPin.sha256 || manifest.source.executionArn !== record.executionArn) throw badRequest('Archive adapter returned mismatched provenance');
      const hydrationBytes = assertConsumableObjects(manifest.objects, Buffer.byteLength(JSON.stringify(manifest)));
      const ds = { name, projectId: record.projectId, owner: record.owner, ownerSubject: record.ownerSubject,
        pipelineArchiveId: record.id, tags: ['sagemaker-pipeline'], latestVersion: 0, createdAt: record.createdAt, updatedAt: this.now() };
      const reserved = await this.d.repo.kv.put({ pk: `DS#${name}`, sk: 'META', gsi1pk: 'TYPE#DS', gsi1sk: `${ds.createdAt}#${name}`, ...ds }, 'not_exists');
      if (!reserved) {
        const existing = await this.d.repo.kv.get(`DS#${name}`, 'META');
        if (!existing || existing.projectId !== ds.projectId || existing.ownerSubject !== ds.ownerSubject || existing.pipelineArchiveId !== record.id) throw badRequest('Generated archive dataset name is already owned');
      }
      const uri = `s3://${manifestPin.bucket}/${manifestPin.key.slice(0, -'manifest.json'.length)}`;
      // Public allocation API; no fabricated dashboard workflow/task producer.
      // READY and the archive receipt are committed atomically below.
      const draft = { dataset: name, projectId: record.projectId, ownerSubject: record.ownerSubject, pipelineArchiveId: record.id,
        uri, state: 'PENDING' as const, imported: true, versionRevision: 0, tags: ds.tags, createdAt: record.createdAt, createdBy: record.owner };
      const allocated = await this.d.repo.publishDatasetVersion(ds, draft, `pipeline:${record.id}`);
      const guard = await datasetGuard(this.d.repo.kv, name);
      const dataset = { name, version: allocated.version, uri, manifestUri: `s3://${manifestPin.bucket}/${manifestPin.key}`,
        manifestHash: manifestPin.sha256, manifestVersionId: manifestPin.versionId };
      const completed: PipelineDatasetVersion = { ...allocated, pipelineArchiveId: record.id, state: 'READY',
        manifestUri: dataset.manifestUri, manifestHash: dataset.manifestHash, manifestVersionId: dataset.manifestVersionId,
        fsxPath: `/fsx/datasets/projects/${record.projectId}/${name}/v${allocated.version}`, hydrationBytes,
        objectCount: manifest.objects.length, sizeBytes: manifest.objects.reduce((n, file) => n + file.bytes, 0),
        verifiedAt: this.now(), versionRevision: (allocated.versionRevision ?? 0) + 1 };
      const ready: PipelineArchiveRecord = { ...running, status: 'READY', provenance, dataset, version: allocated.version,
        checkpoint: manifest.objects.find(file => file.path === manifest.checkpointPath),
        directory: { schemaVersion: 1, algorithm: manifest.directory.algorithm, digest: manifest.directory.digest, fileCount: manifest.directory.files.length },
        directoryManifest: manifest.objects.find(file => file.path === manifest.directoryManifestPath),
        sourceObject: manifest.sourceObject, reports: manifest.reports, updatedAt: this.now() };
      if (!ready.checkpoint || !ready.directoryManifest) throw badRequest('Archive bundle is incomplete');
      if (Buffer.byteLength(JSON.stringify(ready)) > 300_000) throw badRequest('Archive metadata is too large; select fewer report steps');
      signal.throwIfAborted();
      if (!await this.d.repo.kv.transaction([
        { kind: 'check', pk: key.pk, sk: 'LEASE', condition: { equals: { holder }, after: { expires: Math.floor(Date.now() / 1000) } } },
        { kind: 'check', pk: guard.pk, sk: guard.sk, condition: { equals: { state: 'ACTIVE' } } },
        { kind: 'check', ...pipelineExecutionKey(record.executionArn), condition: { equals: { projectId: record.projectId } } },
        { kind: 'put', item: { pk: `DS#${name}`, sk: `V#${String(allocated.version).padStart(6, '0')}`, ...completed },
          condition: { equals: { state: 'PENDING', pipelineArchiveId: record.id, versionRevision: allocated.versionRevision ?? 0 } } },
        { kind: 'put', item: item(ready), condition: { equals: { status: 'ARCHIVING' } } },
      ])) throw new HttpError(409, 'Archive publication was cancelled, deleted or superseded');
    } catch (error) {
      // Shutdown/lease loss is an interrupted archive, not failed SM training
      // (nor a permanent archive failure). Keep its queue state and identity so
      // the next controller can adopt the same immutable objects/version.
      if (signal.aborted || (error as Error).name === 'AbortError') return;
      const current = await this.d.repo.kv.get(key.pk, key.sk);
      if (!signal.aborted && current && ['PENDING', 'ARCHIVING'].includes(String(current.status))) await this.d.repo.kv.transaction([
        { kind: 'check', pk: key.pk, sk: 'LEASE', condition: { equals: { holder }, after: { expires: Math.floor(Date.now() / 1000) } } },
        { kind: 'put', item: item({ ...clean(current), status: 'FAILED', error: String((error as Error).message).slice(0, 1000), updatedAt: this.now() }),
          condition: { equals: { status: current.status } } },
      ]);
    } finally {
      clearInterval(timer);
      controller.abort();
      // A renewal that already reached DynamoDB must settle before release;
      // otherwise it could recreate this worker's lease after cleanup.
      await renewal;
      await this.d.repo.kv.transaction([{ kind: 'delete', pk: key.pk, sk: 'LEASE', condition: { equals: { holder } } }]);
    }
  }
}
export function pipelineArchives(repo = getRepo()) {
  return new PipelineArchives({ repo, sources: sageMakerSources(), storage: new S3PipelineArchiveStorage(process.env.DASHBOARD_ARTIFACT_BUCKET ?? '') });
}
const activeArchives = new Set<string>();
export async function reconcilePipelineArchives(repo = getRepo(), signal?: AbortSignal) {
  if (signal?.aborted) return;
  const pending = (await repo.kv.queryGsi1('TYPE#PIPELINE_ARCHIVE', { limit: 10 }))
    .filter(row => ['PENDING', 'ARCHIVING'].includes(String(row.status)));
  if (signal?.aborted || !pending.length || activeArchives.size) return;
  const service = pipelineArchives(repo);
  const row = pending[0], record = clean(row);
  activeArchives.add(record.id);
  // Large model copies must not block the worker's session/DCV cleanup loop.
  void service.reconcile(record, signal).catch(error => console.error('[pipeline-archive]', record.id, (error as Error).name))
    .finally(() => activeArchives.delete(record.id));
}
