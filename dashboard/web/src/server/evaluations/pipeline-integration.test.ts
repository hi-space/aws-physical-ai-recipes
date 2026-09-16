import { beforeEach, describe, expect, it, vi } from 'vitest';
const clients = vi.hoisted(() => ({ s3: vi.fn(), sm: vi.fn() }));
vi.mock('../aws/clients', () => ({ s3: () => ({ send: clients.s3 }), sagemaker: () => ({ send: clients.sm }) }));
import { pipelineFixture, pipelineAdmin, executionArn, packageArn, modelUri, reportUri, sha } from './pipeline-fixtures';
import { pipelineArchiveKey } from './pipeline-types';
import { workflowSchema } from '../workflow/schema';
import type { DatasetVersion, Workflow, Task } from '../store/types';
import { DIRECTORY_DIGEST } from './bundles';
import { validateDatasetInputs } from '../data/versions';
import { PipelineArchives, reconcilePipelineArchives } from '../services/pipeline-archives';
import { S3PipelineArchiveStorage } from './pipeline-storage';
import * as sourceFactory from './sagemaker-source';

let f: Awaited<ReturnType<typeof pipelineFixture>>;
beforeEach(async () => {
  f = await pipelineFixture();
  clients.s3.mockReset().mockImplementation(command => f.storage.send(command));
  clients.sm.mockReset().mockImplementation(command => f.aws.send(command));
});
async function archived(reports = ['SmokeEval']) {
  const requested = await f.archives.request(pipelineAdmin, 'a', executionArn, { trainingStep: 'GR00TFinetune', reportSteps: reports });
  await f.archives.reconcile(requested);
  const ready = await f.archives.get(pipelineAdmin, 'a', requested.id);
  expect(ready.status, ready.error).toBe('READY');
  return ready;
}
async function registered() {
  const archive = await archived();
  const model = await f.models.register(pipelineAdmin, 'a', {
    name: 'Fixture pipeline candidate', dataset: archive.datasetName, version: archive.version, checkpointPath: 'model/model.tar.gz',
  });
  return { archive, model };
}
async function closedLoop(model: Awaited<ReturnType<typeof registered>>['model'], changes: Record<string, unknown> = {}) {
  const path = 'projects/a/runs/eval-run/attempts/1/evaluate/publication/';
  const report = { schemaVersion: 1, type: 'closed_loop', status: 'completed', task: 'LeIsaac-SO101-PickOrange-v0',
    seed: 2042, episodeCount: 20, successCount: 20, successRate: 1, timeoutCount: 0,
    checkpointDigestKind: DIRECTORY_DIGEST, checkpointDigest: model.checkpointBundle!.directory.digest,
    simulator: { name: 'Isaac Lab', version: 'fixture-only', sceneVersion: 'scene-fixture' }, latencyMs: { p95: 10 },
    videoUri: 'videos/first.mp4', episodes: Array.from({ length: 20 }, (_, index) => ({
      index, seed: 2042 + index, steps: 1, success: true, timeout: false, videoUri: 'videos/first.mp4',
    })), ...changes };
  const entries = [
    ['evaluation.json', JSON.stringify(report)], ['videos/first.mp4', 'fixture-video'],
  ].map(([file, body]) => {
    const stored = f.storage.put('archive', path + file, body);
    return { path: file, key: path + file, bytes: stored.body.length, versionId: stored.version, checksumSHA256: stored.checksum, checksumType: 'FULL_OBJECT' };
  });
  const manifest = { schemaVersion: 1, identity: 'workflow:eval-publication:1', createdAt: '2026-09-16T01:00:00.000Z', objects: entries };
  const stored = f.storage.put('archive', path + 'manifest.json', JSON.stringify(manifest));
  const version: DatasetVersion = { dataset: 'closed-loop', version: 1, projectId: 'a', ownerSubject: 'alice-sub',
    uri: `s3://archive/${path}`, state: 'READY', publicationId: 'eval-publication', producedAttempt: 1,
    producedBy: { workflowId: 'eval-run', task: 'evaluate' }, manifestUri: `s3://archive/${path}manifest.json`, manifestHash: sha(stored.body),
    tags: [], createdAt: manifest.createdAt, createdBy: 'alice', objectCount: 2, sizeBytes: entries.reduce((sum, file) => sum + file.bytes, 0) };
  await f.repo.putDataset({ name: version.dataset, projectId: 'a', owner: 'alice', ownerSubject: 'alice-sub', latestVersion: 1, tags: [], createdAt: manifest.createdAt, updatedAt: manifest.createdAt });
  await f.repo.putVersion(version);
  const spec = workflowSchema.parse({ workflow: { name: 'eval-run', resources: { gpu: { gpu: 1 } },
    tasks: [{ name: 'evaluate', resource: 'gpu', image: 'fixture/isaac', command: ['fixture-only'],
      inputs: [{ dataset: { name: model.source.dataset.name, version: model.source.dataset.version } }] }] } });
  const workflow: Workflow = { id: 'eval-run', name: 'eval-run', projectId: 'a', owner: 'alice', ownerSubject: 'alice-sub',
    namespace: 'hyperpod-ns-a', status: 'SUCCEEDED', spec, specYaml: '', vars: {}, createdAt: manifest.createdAt, updatedAt: manifest.createdAt,
    taskCount: 1, succeededCount: 1, failedCount: 0, datasetSnapshots: { evaluate: { 0: {
      name: model.source.dataset.name, version: model.source.dataset.version, uri: model.source.dataset.uri,
      manifestHash: model.source.dataset.manifestHash, fsxPath: '/fsx/datasets/projects/a/fixture',
    } } } };
  await f.repo.putWorkflow(workflow);
  const task: Task = { workflowId: workflow.id, name: 'evaluate', phase: 'SUCCEEDED', attempts: 1, replicas: 1, updatedAt: manifest.createdAt,
    publishedVersions: [{ dataset: version.dataset, version: 1 }], artifactReceipts: { receipt: { uri: version.uri,
      manifestUri: version.manifestUri!, manifestHash: version.manifestHash!, verifiedAt: manifest.createdAt, objectCount: 2, sizeBytes: version.sizeBytes! } } };
  await f.repo.putTask(task);
  return f.models.ingest(pipelineAdmin, 'a', { modelId: model.id, dataset: 'closed-loop', version: 1 });
}

describe('SageMaker → project model archive (fixture AWS clients, no live training)', () => {
  it('does not acquire a lease or start an archive after shutdown', async () => {
    const request = await f.archives.request(pipelineAdmin, 'a', executionArn, { trainingStep: 'GR00TFinetune' });
    const shutdown = new AbortController(); shutdown.abort();
    const query = vi.spyOn(f.repo.kv, 'queryGsi1');
    await reconcilePipelineArchives(f.repo, shutdown.signal);
    expect(query).not.toHaveBeenCalled();
    await f.archives.reconcile(request, shutdown.signal);
    expect((await f.archives.get(pipelineAdmin, 'a', request.id)).status).toBe('PENDING');
    expect(await f.repo.kv.get(pipelineArchiveKey('a', request.id).pk, 'LEASE')).toBeUndefined();
    expect(f.storage.commands).toHaveLength(0);
  });
  it('passes the caller shutdown signal from the archive pump to the selected record', async () => {
    const request = await f.archives.request(pipelineAdmin, 'a', executionArn, { trainingStep: 'GR00TFinetune' });
    const factory = vi.spyOn(sourceFactory, 'sageMakerSources').mockReturnValue(f.sources);
    const reconcile = vi.spyOn(PipelineArchives.prototype, 'reconcile').mockResolvedValueOnce(undefined);
    const shutdown = new AbortController();
    try {
      await reconcilePipelineArchives(f.repo, shutdown.signal);
      expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({ id: request.id }), shutdown.signal);
      await Promise.resolve(); await Promise.resolve();
    } finally { reconcile.mockRestore(); factory.mockRestore(); }
  });
  it('interrupts an active copy without marking training/archive failed and resumes the same operation', async () => {
    const request = await f.archives.request(pipelineAdmin, 'a', executionArn, { trainingStep: 'GR00TFinetune' });
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const archive = vi.spyOn(S3PipelineArchiveStorage.prototype, 'archive').mockImplementationOnce(
      async (_source, _project, _id, _at, signal) => new Promise((_resolve, reject) => {
        started();
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }));
    const shutdown = new AbortController(), work = f.archives.reconcile(request, shutdown.signal);
    try {
      await entered; shutdown.abort(); await work;
      const paused = await f.archives.get(pipelineAdmin, 'a', request.id);
      expect(paused).toMatchObject({ status: 'ARCHIVING', id: request.id });
      expect(paused.error).toBeUndefined();
      expect(await f.repo.kv.get(pipelineArchiveKey('a', request.id).pk, 'LEASE')).toBeUndefined();
      expect(f.aws.pipelineStatus).toBe('Succeeded'); expect(f.aws.trainingStatus).toBe('Completed');
      await f.archives.reconcile(paused, new AbortController().signal);
      expect((await f.archives.get(pipelineAdmin, 'a', request.id)).status).toBe('READY');
      expect(await f.repo.listVersions(request.datasetName)).toHaveLength(1);
      expect(f.aws.commands.some(command => /Start|Stop|Update/.test(command.name))).toBe(false);
    } finally { shutdown.abort(); await work; archive.mockRestore(); }
  });
  it('adopts already copied immutable artifacts after shutdown instead of relabeling them failed', async () => {
    const request = await f.archives.request(pipelineAdmin, 'a', executionArn, { trainingStep: 'GR00TFinetune' });
    const original = S3PipelineArchiveStorage.prototype.archive, shutdown = new AbortController();
    const archive = vi.spyOn(S3PipelineArchiveStorage.prototype, 'archive').mockImplementationOnce(async function (this: S3PipelineArchiveStorage, ...args) {
      const result = await original.apply(this, args);
      shutdown.abort(); args[4].throwIfAborted();
      return result;
    });
    try {
      await f.archives.reconcile(request, shutdown.signal);
      const paused = await f.archives.get(pipelineAdmin, 'a', request.id);
      expect(paused.status).toBe('ARCHIVING'); expect(paused.error).toBeUndefined();
      const copies = f.storage.commands.filter(command => command.name === 'CopyObjectCommand').length;
      await f.archives.reconcile(paused, new AbortController().signal);
      expect((await f.archives.get(pipelineAdmin, 'a', request.id)).status).toBe('READY');
      expect(f.storage.commands.filter(command => command.name === 'CopyObjectCommand')).toHaveLength(copies);
    } finally { archive.mockRestore(); }
  });
  it('does not delete a successor lease or write a failure after interrupted ownership loss', async () => {
    const request = await f.archives.request(pipelineAdmin, 'a', executionArn, { trainingStep: 'GR00TFinetune' });
    const shutdown = new AbortController(), pk = pipelineArchiveKey('a', request.id).pk;
    const archive = vi.spyOn(S3PipelineArchiveStorage.prototype, 'archive').mockImplementationOnce(async () => {
      await f.repo.kv.put({ pk, sk: 'LEASE', holder: 'successor', expires: Math.floor(Date.now() / 1000) + 120 });
      shutdown.abort(); throw shutdown.signal.reason;
    });
    try {
      await f.archives.reconcile(request, shutdown.signal);
      expect(await f.repo.kv.get(pk, 'LEASE')).toMatchObject({ holder: 'successor' });
      expect((await f.archives.get(pipelineAdmin, 'a', request.id)).status).toBe('ARCHIVING');
    } finally { archive.mockRestore(); }
  });
  it('streams real tar bytes through the real adapters and publishes pinned project data without fake workflow rows', async () => {
    const { archive, model } = await registered();
    expect(archive.checkpoint?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(archive.directory).toMatchObject({ digest: f.directory.digest, fileCount: 3, algorithm: DIRECTORY_DIGEST });
    expect(model.source).toMatchObject({ kind: 'sagemaker-pipeline', task: 'GR00TFinetune',
      pipeline: { executionArn, ownerSubject: 'alice-sub', training: { artifactUri: modelUri } } });
    expect(model.source.workflowId).toBeUndefined();
    expect((await f.repo.listWorkflows()).length).toBe(0);
    expect(model.registryLink).toMatchObject({ arn: packageArn, observedApprovalStatus: 'Approved', sourceMeaning: 'smoke_only' });
    expect(model.qualityApproval).toBeUndefined();
    expect(model.checkpointBundle?.directory.digest).not.toBe(model.checkpoint.sha256);
    expect(model.evaluationLaunch?.template).toBe('leisaac-evaluate');
    expect(f.storage.commands.some(command => command.name === 'ListObjectsV2Command')).toBe(false);
    expect(f.aws.commands.some(command => command.name === 'UpdateModelPackageCommand')).toBe(false);
    const version = await f.repo.getVersion(archive.datasetName, archive.version!);
    expect(version).toMatchObject({ state: 'READY', manifestHash: archive.dataset!.manifestHash, pipelineArchiveId: archive.id });
  });
  it('adopts repeated import requests and snapshot versions', async () => {
    const first = await archived();
    const repeated = await f.archives.request(pipelineAdmin, 'a', executionArn, { trainingStep: 'GR00TFinetune', reportSteps: ['SmokeEval'] });
    expect(repeated.id).toBe(first.id); expect(repeated.status).toBe('READY');
    expect(await f.repo.listVersions(first.datasetName)).toHaveLength(1);
    const row = await f.repo.kv.get(pipelineArchiveKey('a', first.id).pk, 'META');
    expect(row?.gsi1pk).toBe('TYPE#PIPELINE_ARCHIVE_HISTORY');
  });
  it('archives a supported processing-job report from its actual declared output', async () => {
    f.aws.processingReport = true;
    const archive = await archived();
    expect(archive.reports?.[0].source.jobType).toBe('processing');
    expect(f.aws.commands.some(command => command.name === 'DescribeProcessingJobCommand')).toBe(true);
  });
  it('can attach a later report selection only when its original model version and producer are identical', async () => {
    const initial = await archived([]);
    const model = await f.models.register(pipelineAdmin, 'a', { name: 'First archive', dataset: initial.datasetName, version: initial.version, checkpointPath: 'model/model.tar.gz' });
    const withReport = await archived(['SmokeEval']);
    const evaluation = await f.models.ingest(pipelineAdmin, 'a', { modelId: model.id, dataset: withReport.datasetName,
      version: withReport.version, reportPath: 'reports/SmokeEval/evaluation.json' });
    expect(evaluation.metrics.kind).toBe('smoke');
    expect(model.source.dataset.name).not.toBe(evaluation.source.dataset.name);
  });
  it.each(['Failed', 'Stopped', 'Executing'])('rejects pipeline status %s even when artifact objects exist', async status => {
    f.aws.pipelineStatus = status;
    await expect(f.archives.request(pipelineAdmin, 'a', executionArn, { trainingStep: 'GR00TFinetune' })).rejects.toMatchObject({ status: 400 });
    expect(f.storage.commands).toHaveLength(0);
  });
  it('does not fabricate GR00T success after a failed/OOM training job', async () => {
    f.aws.trainingStatus = 'Failed';
    await expect(f.archives.request(pipelineAdmin, 'a', executionArn, { trainingStep: 'GR00TFinetune' })).rejects.toThrow(/did not produce/);
    expect(await f.repo.listDatasets()).toHaveLength(0);
  });
  it('rejects cached producers, foreign artifact buckets and reports using another model', async () => {
    f.aws.cached = true;
    await expect(archived()).rejects.toThrow(/cached/);
    f.aws.cached = false; f.aws.modelArtifactUri = 's3://foreign/private/model.tar.gz';
    await expect(archived()).rejects.toMatchObject({ status: 403 });
    f.aws.modelArtifactUri = modelUri; f.aws.reportModelUri = 's3://source/another-model.tar.gz';
    await expect(archived()).rejects.toThrow(/exact model input/);
  });
  it('rejects cross-project access and unregistered legacy imports, including platform admin', async () => {
    await expect(f.archives.request({ ...pipelineAdmin, subject: 'reader-sub' }, 'a', executionArn, { trainingStep: 'GR00TFinetune' })).rejects.toMatchObject({ status: 403 });
    await f.repo.kv.del(`PIPELINE_EXECUTION#${executionArn}`, 'META');
    await expect(f.archives.request({ ...pipelineAdmin, role: 'admin' }, 'a', executionArn, { trainingStep: 'GR00TFinetune' })).rejects.toMatchObject({ status: 403 });
    expect(f.aws.commands).toHaveLength(0);
  });
  it('never marks a cancelled archive/dataset READY', async () => {
    const request = await f.archives.request(pipelineAdmin, 'a', executionArn, { trainingStep: 'GR00TFinetune' });
    await f.archives.cancel(pipelineAdmin, 'a', request.id);
    await f.archives.reconcile(request);
    expect((await f.archives.get(pipelineAdmin, 'a', request.id)).status).toBe('CANCELLED');
    expect(await f.repo.listDatasets()).toHaveLength(0);
  });
  it('atomically fences cancellation after version allocation and before READY', async () => {
    const request = await f.archives.request(pipelineAdmin, 'a', executionArn, { trainingStep: 'GR00TFinetune' });
    const publish = f.repo.publishDatasetVersion.bind(f.repo);
    vi.spyOn(f.repo, 'publishDatasetVersion').mockImplementation(async (...args) => {
      const version = await publish(...args);
      await f.archives.cancel(pipelineAdmin, 'a', request.id);
      return version;
    });
    await f.archives.reconcile(request);
    expect((await f.archives.get(pipelineAdmin, 'a', request.id)).status).toBe('CANCELLED');
    expect((await f.repo.listVersions(request.datasetName))[0].state).toBe('PENDING');
  });
  it('does not let a peer cancel an owned archive operation', async () => {
    const request = await f.archives.request(pipelineAdmin, 'a', executionArn, { trainingStep: 'GR00TFinetune' });
    await expect(f.archives.cancel({ ...pipelineAdmin, subject: 'peer-sub' }, 'a', request.id)).rejects.toMatchObject({ status: 403 });
  });
  it('retains smoke as smoke; an existing AWS Approved flag cannot grant application quality', async () => {
    const { archive, model } = await registered();
    const evaluation = await f.models.ingest(pipelineAdmin, 'a', { modelId: model.id, dataset: archive.datasetName, version: archive.version,
      reportPath: 'reports/SmokeEval/evaluation.json' });
    expect(evaluation).toMatchObject({ verification: 'published_pipeline_report', metrics: { kind: 'smoke' }, smoke: { passed: true } });
    expect(evaluation.primaryVideo).toBeUndefined(); expect(evaluation.successRate).toBeUndefined();
    const gate = await f.models.promote(pipelineAdmin, 'a', model.id, { evaluationId: evaluation.id });
    expect(gate.gate.decision.status).toBe('review');
    await expect(f.models.promote(pipelineAdmin, 'a', model.id, { evaluationId: evaluation.id, approve: true })).rejects.toMatchObject({ status: 400 });
    expect(f.aws.commands.some(command => command.name === 'UpdateModelPackageCommand')).toBe(false);
  });
  it('binds a real report directory digest to its separately pinned full-file model archive', async () => {
    const { model } = await registered(), evaluation = await closedLoop(model);
    expect(evaluation).toMatchObject({ metrics: { kind: 'simulation', episodes: 20, successes: 20 },
      reportedCheckpointDigest: f.directory.digest, checkpointDigest: model.checkpoint.sha256 });
    expect(evaluation.checkpointDigest).not.toBe(f.directory.digest);
    const approved = await f.models.promote(pipelineAdmin, 'a', model.id, { evaluationId: evaluation.id, approve: true });
    expect(approved.model.qualityApproval?.approved).toBe(true);
    expect(f.aws.commands.some(command => command.name === 'UpdateModelPackageCommand')).toBe(false);
    vi.stubEnv('DASHBOARD_ARTIFACT_BUCKET', 'archive');
    try { await expect(validateDatasetInputs(f.repo, (await f.repo.getWorkflow('eval-run'))!)).resolves.toBeUndefined(); }
    finally { vi.unstubAllEnvs(); }
  });
  it.each(['wrong-directory', 'ambiguous-legacy'])('rejects %s checkpoint digest evidence', async mode => {
    const { model } = await registered();
    await expect(closedLoop(model, mode === 'wrong-directory'
      ? { checkpointDigest: '0'.repeat(64) } : { checkpointDigestKind: undefined })).rejects.toMatchObject({ status: 400 });
  });
  it('keeps an accepted but still-processing Registry update pending', async () => {
    const { model } = await registered(), evaluation = await closedLoop(model);
    const { gate } = await f.models.promote(pipelineAdmin, 'a', model.id, { evaluationId: evaluation.id, approve: true });
    f.aws.statusAfterUpdate = 'InProgress';
    expect((await f.models.propagateRegistry(pipelineAdmin, 'a', model.id, { gateId: gate.id, confirm: true })).registryApproval.status).toBe('PENDING');
  });
  it('requires explicit project-admin propagation and confirms the actual UpdateModelPackage API result', async () => {
    const { model } = await registered(), evaluation = await closedLoop(model);
    const { gate } = await f.models.promote(pipelineAdmin, 'a', model.id, { evaluationId: evaluation.id, approve: true });
    await expect(f.models.propagateRegistry({ ...pipelineAdmin, subject: 'peer-sub' }, 'a', model.id, { gateId: gate.id, confirm: true })).rejects.toMatchObject({ status: 403 });
    await expect(f.models.propagateRegistry(pipelineAdmin, 'a', model.id, { gateId: gate.id, confirm: false })).rejects.toMatchObject({ status: 400 });
    const result = await f.models.propagateRegistry(pipelineAdmin, 'a', model.id, { gateId: gate.id, confirm: true });
    expect(result.registryApproval.status).toBe('CONFIRMED');
    const updates = f.aws.commands.filter(command => command.name === 'UpdateModelPackageCommand');
    expect(updates).toHaveLength(1);
    expect(updates[0].input).toMatchObject({ ModelPackageArn: packageArn, ModelApprovalStatus: 'Approved',
      CustomerMetadataProperties: { 'pai.project_id': 'a', 'pai.model_id': model.id, 'pai.gate_id': gate.id, 'pai.checkpoint_sha256': model.checkpoint.sha256 } });
    expect(updates[0].input.ClientToken).toMatch(/^[a-f0-9]{36}$/);
  });
  it.each(['failed', 'unconfirmed', 'foreign-owner', 'changed-artifact'])('does not report a successful registry outcome for %s', async kind => {
    const { model } = await registered(), evaluation = await closedLoop(model);
    const { gate } = await f.models.promote(pipelineAdmin, 'a', model.id, { evaluationId: evaluation.id, approve: true });
    if (kind === 'failed') f.aws.failUpdate = true;
    if (kind === 'unconfirmed') f.aws.confirmUpdate = false;
    if (kind === 'foreign-owner') f.aws.metadata['pai.project_id'] = 'b';
    if (kind === 'changed-artifact') f.storage.put('source', 'output/train-owned/output/model.tar.gz', 'replaced');
    const operation = f.models.propagateRegistry(pipelineAdmin, 'a', model.id, { gateId: gate.id, confirm: true });
    if (['foreign-owner', 'changed-artifact'].includes(kind)) {
      await expect(operation).rejects.toMatchObject({ status: 400 });
      expect(f.aws.commands.some(command => command.name === 'UpdateModelPackageCommand')).toBe(false);
    } else expect((await operation).registryApproval.status).toBe(kind === 'failed' ? 'ERROR' : 'PENDING');
  });
});
