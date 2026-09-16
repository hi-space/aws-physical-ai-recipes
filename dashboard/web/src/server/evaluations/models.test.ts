import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelsService, DEFAULT_POLICY } from '../services/models';
import { alice, bob, reader, admin, fixture, now } from './test-fixtures';

let data: Awaited<ReturnType<typeof fixture>>;
let service: ModelsService;
const registration = { name: 'SO-101 candidate', dataset: 'weights-run', version: 1, checkpointPath: 'final/model.zip' };
const ingestion = { dataset: 'evaluation-run', version: 1, reportPath: 'evaluation.json' };
beforeEach(async () => {
  data = await fixture();
  service = new ModelsService({ repo: data.repo, objects: data.objects, artifactBucket: 'archive', now: () => new Date(now) });
});
describe('model/evaluation provenance and application approval', () => {
  it('registers immutable object and source lineage without inventing quality approval', async () => {
    const model = await service.register(alice, 'a', registration);
    expect(model).toMatchObject({ projectId: 'a', ownerSubject: 'alice-sub',
      checkpoint: { versionId: 'object-v1', sha256: data.modelDigest, checksumType: 'FULL_OBJECT' },
      normalization: { sha256: data.statsDigest }, source: { workflowId: 'train-run', task: 'train', attempt: 1,
        dataset: { manifestVersionId: 'manifest-v1', manifestHash: data.source.manifestHash } } });
    expect(model.source.inputs[0]).toMatchObject({ name: 'demonstrations', version: 3 });
    expect(model.source.image).toContain('@sha256:');
    expect(model.qualityApproval).toBeUndefined();
    expect(model.evaluationLaunch?.href).toContain('checkpoint_bundle=final');
    expect(model.evaluationLaunch?.href).toContain('dataset_version=1');
    expect(await service.register(alice, 'a', registration)).toEqual(model);
    expect((await service.list(alice, 'a')).models).toHaveLength(1);
  });
  it('authorizes the project in every service and never reads object storage for unauthorized requests', async () => {
    await expect(service.list(bob, 'a')).rejects.toMatchObject({ status: 403 });
    await expect(service.register(reader, 'a', registration)).rejects.toMatchObject({ status: 403 });
    await expect(service.register({ ...alice, role: 'viewer' }, 'a', registration)).rejects.toMatchObject({ status: 403 });
    expect(data.objects.heads).toHaveLength(0);
    const model = await service.register(alice, 'a', registration);
    expect((await service.list(bob, 'b')).models).toEqual([]);
    await expect(service.get(bob, 'b', model.id)).rejects.toMatchObject({ status: 404 });
    await expect(service.register(alice, 'a', { ...registration, projectId: 'b', qualityApproval: true })).rejects.toMatchObject({ status: 400 });
  });
  it.each(['PENDING', 'missing-producer', 'failed-task', 'wrong-attempt', 'missing-receipt'])('rejects uncommitted or unproven registration: %s', async (kind) => {
    const v = { ...data.source };
    const task = (await data.repo.listTasks('train-run'))[0];
    if (kind === 'PENDING') v.state = 'PENDING';
    if (kind === 'missing-producer') delete v.producedBy;
    if (kind === 'failed-task') task.phase = 'FAILED';
    if (kind === 'wrong-attempt') task.attempts = 2;
    if (kind === 'missing-receipt') task.artifactReceipts = {};
    await data.repo.putVersion(v); await data.repo.putTask(task);
    await expect(service.register(alice, 'a', registration)).rejects.toThrow();
  });
  it('rejects replaced manifests, escaped selections, missing versions and byte corruption', async () => {
    await expect(service.register(alice, 'a', { ...registration, checkpointPath: '../model.zip' })).rejects.toThrow();
    const key = data.source.manifestUri!.replace('s3://archive/', '');
    data.objects.add(key, { schemaVersion: 1, objects: [] }, 'replacement-version');
    await expect(service.register(alice, 'a', registration)).rejects.toThrow(/manifest hash/i);
    data.objects.latest.set(`archive/${key}`, 'manifest-v1');
    const object = data.objects.find({ bucket: 'archive', key: data.source.uri.replace('s3://archive/', '') + 'final/model.zip', versionId: 'object-v1' });
    object.metadata.versionId = 'different-version';
    await expect(service.register(alice, 'a', registration)).rejects.toThrow(/VersionId/);
  });
  it('ingests only versioned published reports matched to the model snapshot and digest', async () => {
    const model = await service.register(alice, 'a', registration);
    const evaluation = await service.ingest(alice, 'a', { ...ingestion, modelId: model.id });
    expect(evaluation).toMatchObject({ verification: 'published_runtime_report', projectId: 'a', modelId: model.id,
      inputMatch: 'dataset_snapshot', metrics: { kind: 'simulation', episodes: 20, successes: 20, latencyP95Ms: 5 },
      report: { versionId: 'object-v1', path: 'evaluation.json' }, checkpointDigest: model.checkpoint.sha256 });
    expect(await service.ingest(alice, 'a', { ...ingestion, modelId: model.id })).toEqual(evaluation);
    expect((await service.get(alice, 'a', model.id)).evaluations).toHaveLength(1);
    expect(await service.artifact(alice, 'a', evaluation.id, 'report')).toContain('versionId=object-v1');
    expect(data.objects.reads.filter(r => r.key.endsWith('/evaluation.json')).every(r => r.versionId === 'object-v1')).toBe(true);
    await expect(service.ingest(alice, 'a', { ...ingestion, modelId: model.id, metrics: { successes: 20 } })).rejects.toMatchObject({ status: 400 });
    await expect(service.getEvaluation(bob, 'b', evaluation.id)).rejects.toMatchObject({ status: 404 });
  });
  it('requires snapshot identity even when checkpoint bytes happen to match', async () => {
    const model = await service.register(alice, 'a', registration);
    const wf = (await data.repo.getWorkflow('eval-run'))!;
    wf.datasetSnapshots!.evaluate[0].manifestHash = '0'.repeat(64);
    await data.repo.putWorkflow(wf);
    await expect(service.ingest(alice, 'a', { ...ingestion, modelId: model.id })).rejects.toThrow(/input snapshot/i);
  });
  it('accepts the exact producer task output within the same pipeline run', async () => {
    const training = (await data.repo.getWorkflow('train-run'))!;
    const evaluating = (await data.repo.getWorkflow('eval-run'))!;
    training.spec.workflow.tasks.push({ ...evaluating.spec.workflow.tasks[0], inputs: [{ task: 'train' }] });
    await data.repo.putWorkflow(training);
    const model = await service.register(alice, 'a', registration);
    await data.publish('evaluation-run', 'train-run', 'evaluate', {
      'evaluation.json': data.report, ...Object.fromEntries(data.report.episodes.map(e => [e.videoUri, 'video'])),
    });
    expect(await service.ingest(alice, 'a', { ...ingestion, modelId: model.id })).toMatchObject({ inputMatch: 'same_run_task_output' });
  });
  it('does not read an archive object in another project even if metadata is forged', async () => {
    await data.repo.putVersion({ ...data.source, uri: 's3://archive/projects/b/stolen/', manifestUri: 's3://archive/projects/b/stolen/manifest.json' });
    const task = (await data.repo.listTasks('train-run'))[0];
    Object.values(task.artifactReceipts!).forEach(receipt => { receipt.uri = 's3://archive/projects/b/stolen/'; receipt.manifestUri = 's3://archive/projects/b/stolen/manifest.json'; });
    await data.repo.putTask(task);
    await expect(service.register(alice, 'a', registration)).rejects.toThrow(/project archive/i);
    expect(data.objects.heads).toHaveLength(0);
  });
  it('fences registration against a dataset changing while its objects are being verified', async () => {
    const original = data.objects.head.bind(data.objects);
    vi.spyOn(data.objects, 'head').mockImplementation(async reference => {
      const metadata = await original(reference);
      if (reference.key.endsWith('/model.zip')) await data.repo.putVersion({ ...data.source, state: 'PENDING' });
      return metadata;
    });
    await expect(service.register(alice, 'a', registration)).rejects.toMatchObject({ status: 409 });
    expect((await service.list(alice, 'a')).models).toHaveLength(0);
  });
  it.each(['checkpointDigest', 'normalizationDigest'])('rejects wrong %s from a published runtime report', async field => {
    const model = await service.register(alice, 'a', registration);
    await data.publish('evaluation-run', 'eval-run', 'evaluate', {
      'evaluation.json': { ...data.report, [field]: '0'.repeat(64) },
      ...Object.fromEntries(data.report.episodes.map(e => [e.videoUri, 'video'])),
    });
    await expect(service.ingest(alice, 'a', { ...ingestion, modelId: model.id })).rejects.toThrow(/digest/i);
  });
  it('rejects report content modified without a matching published checksum', async () => {
    const model = await service.register(alice, 'a', registration);
    const file = data.objects.find({ bucket: 'archive', key: data.evaluation.uri.replace('s3://archive/', '') + 'evaluation.json', versionId: 'object-v1' });
    file.body = Buffer.from(JSON.stringify({ ...data.report, successCount: 0 }));
    await expect(service.ingest(alice, 'a', { ...ingestion, modelId: model.id })).rejects.toThrow(/digest/i);
  });
  it('records explicit application approval separately from checking a policy', async () => {
    const model = await service.register(alice, 'a', registration);
    const evaluation = await service.ingest(alice, 'a', { ...ingestion, modelId: model.id });
    const preview = await service.promote(alice, 'a', model.id, { evaluationId: evaluation.id, policy: DEFAULT_POLICY, approve: false });
    expect(preview.gate.decision.status).toBe('pass');
    expect(preview.model.qualityApproval).toBeUndefined();
    const approved = await service.promote(alice, 'a', model.id, { evaluationId: evaluation.id, policy: DEFAULT_POLICY, approve: true });
    expect(approved.model.qualityApproval).toMatchObject({ evaluationId: evaluation.id, policy: DEFAULT_POLICY, approved: true });
    expect((await service.get(alice, 'a', model.id)).gates).toHaveLength(2);
    await expect(service.promote(reader, 'a', model.id, { evaluationId: evaluation.id, policy: DEFAULT_POLICY, approve: true })).rejects.toMatchObject({ status: 403 });
  });
  it('prevents concurrent approval writes from overwriting another decision', async () => {
    const model = await service.register(alice, 'a', registration);
    const evaluation = await service.ingest(alice, 'a', { ...ingestion, modelId: model.id });
    const results = await Promise.allSettled([
      service.promote(alice, 'a', model.id, { evaluationId: evaluation.id, policy: DEFAULT_POLICY, approve: true }),
      service.promote(alice, 'a', model.id, { evaluationId: evaluation.id, policy: { ...DEFAULT_POLICY, minimumSuccessRate: 0.9 }, approve: true }),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { status: 409 } });
    expect((await service.get(alice, 'a', model.id)).gates).toHaveLength(1);
  });
  it.each([
    { episodes: 5, decision: 'review' }, { successes: 10, decision: 'fail' },
    { latency: 500, decision: 'fail' }, { latency: null, decision: 'review' },
  ])('never approves insufficient or failing evidence: %j', async (options) => {
    data = await fixture(options);
    service = new ModelsService({ repo: data.repo, objects: data.objects, artifactBucket: 'archive' });
    const model = await service.register(alice, 'a', registration);
    const evaluation = await service.ingest(alice, 'a', { ...ingestion, modelId: model.id });
    const result = await service.promote(alice, 'a', model.id, { evaluationId: evaluation.id, policy: DEFAULT_POLICY, approve: false });
    expect(result.gate.decision.status).toBe(options.decision);
    expect(result.gate.decision.reasons.length).toBeGreaterThan(0);
    await expect(service.promote(alice, 'a', model.id, { evaluationId: evaluation.id, policy: DEFAULT_POLICY, approve: true })).rejects.toMatchObject({ status: 400 });
    expect((await service.get(alice, 'a', model.id)).model.qualityApproval).toBeUndefined();
  });
  it('keeps composite checksums distinct from full file digests', async () => {
    data = await fixture({ composite: true });
    service = new ModelsService({ repo: data.repo, objects: data.objects, artifactBucket: 'archive' });
    const model = await service.register(alice, 'a', registration);
    expect(model.checkpoint.checksumType).toBe('COMPOSITE');
    expect(model.checkpoint.sha256).toBeUndefined();
    expect(model.evaluationLaunch).toBeUndefined();
    await expect(service.ingest(alice, 'a', { ...ingestion, modelId: model.id })).rejects.toThrow(/full-object/i);
  });
  it('never invokes unscoped legacy sources for researchers and preserves source errors for admins', async () => {
    const legacy = vi.fn(async () => [{ name: 'SageMaker registry', status: 'error' as const, error: 'Source access failed' }]);
    service = new ModelsService({ repo: data.repo, objects: data.objects, artifactBucket: 'archive', legacy });
    await expect(service.legacy(alice, 'a')).rejects.toMatchObject({ status: 403 });
    expect(legacy).not.toHaveBeenCalled();
    expect(await service.legacy(admin, 'a')).toMatchObject({ approvalMeaning: 'smoke_only', sources: [{ status: 'error' }] });
  });
});
