import { beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { MemoryKV } from '../store/dynamo';
import { Repo } from '../store/repo';
import { parseWorkflowYaml } from '../workflow/template';
import type { Workflow } from '../store/types';
import type { RecoveryTask } from '../workflow/checkpoints';
import { RuntimeBroker } from './broker';
import { CheckpointService, type Plan } from './uploads';
import { createRuntimeHandler } from './http';
import { cleanupCheckpointUploads } from './upload-cleanup';
import { activeUploads } from './upload-registry';
import type { ObjectStorage, StoredManifest } from './storage';
import type { MultipartStorage, StoredPart } from './multipart-storage';
import { uploadFileKey, type UploadFile } from './upload-files';

const sha = (text: string) => createHash('sha256').update(text).digest('base64');
const actualSHA = sha('independent object stream');
let broker: RuntimeBroker, service: CheckpointService, repo: Repo, workflow: Workflow, token: string;
let storage: ObjectStorage, multipart: MultipartStorage, parts: StoredPart[];
let objects: Map<string, Awaited<ReturnType<ObjectStorage['head']>>>, manifests: Map<string, StoredManifest>;
let ids: string[], key: string, identity: string, declaredSHA: string, loseCreate: boolean, loseComplete: boolean;
const request = (size = 65 * 1024 ** 2) => ({
  protocolVersion: 2 as const, snapshotId: '1'.repeat(32), purpose: 'checkpoint' as const,
  destination: 's3://artifacts/projects/p/checkpoints/', files: [{ path: 'model.bin', size, checksumSHA256: actualSHA }],
});
beforeEach(async () => {
  repo = new Repo(new MemoryKV()); objects = new Map(); manifests = new Map(); parts = []; ids = [];
  key = ''; identity = ''; declaredSHA = ''; loseCreate = false; loseComplete = false;
  multipart = {
    create: vi.fn(async (_bucket, objectKey, id, digest) => {
      key = objectKey; identity = id; declaredSHA = digest; ids = ['s3-upload-id'];
      if (loseCreate) { loseCreate = false; throw new Error('ambiguous create'); }
      return ids[0];
    }),
    uploads: vi.fn(async () => ids),
    parts: vi.fn(async () => parts.map(part => ({ ...part }))),
    sign: vi.fn(async (_bucket, _key, _id, part) => ({ url: `https://parts.invalid/${part.number}`, headers: { 'x-amz-checksum-sha256': part.checksumSHA256 } })),
    complete: vi.fn(async (_bucket, objectKey, _id, actual, composite) => {
      objects.set(objectKey, { versionId: 'pinned-version', size: actual.reduce((sum: number, part: StoredPart) => sum + part.size, 0),
        checksumSHA256: composite, checksumType: 'COMPOSITE',
        metadata: { 'pai-checkpoint-file': identity, 'pai-full-sha256': declaredSHA } });
      ids = [];
      if (loseComplete) { loseComplete = false; throw new Error('ambiguous complete'); }
    }),
    abort: vi.fn(async () => { ids = []; }),
    deleteVersion: vi.fn(async (_bucket, objectKey, version) => {
      if (objects.get(objectKey)?.versionId === version) objects.delete(objectKey);
      if (manifests.get(objectKey)?.versionId === version) manifests.delete(objectKey);
    }),
    sha256: vi.fn(async (_bucket, _key, _version, _size, _signal, check) => { await check(); return actualSHA; }),
  };
  storage = {
    multipart,
    presignPut: vi.fn(async (_bucket, objectKey, file) => ({ url: `https://put.invalid/${objectKey}`, headers: { 'x-amz-checksum-sha256': file.checksumSHA256 } })),
    head: vi.fn(async (_bucket, objectKey, version) => {
      const value = objects.get(objectKey);
      if (!value || version && value.versionId !== version) throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
      return value;
    }),
    readManifest: vi.fn(async (_bucket, objectKey, _signal, version) => {
      const manifest = manifests.get(objectKey);
      if (version && manifest?.versionId !== version) throw new Error('wrong manifest version');
      return manifest;
    }),
    writeManifest: vi.fn(async (_bucket, objectKey, body) => {
      const manifest = manifests.get(objectKey) ?? { versionId: 'manifest-version', body };
      manifests.set(objectKey, manifest); return manifest;
    }),
    presignGet: vi.fn(async (_bucket, objectKey, version) => `https://get.invalid/${objectKey}?versionId=${version}`),
  };
  const yaml = `workflow:
  name: multipart
  resources: {cpu: {cpu: 1}}
  tasks:
    - name: train
      resource: cpu
      image: python
      command: [python, train.py]
      checkpoint: [{path: "{{output}}", url: "s3://artifacts/projects/p/checkpoints/", frequency: 1m}]
`;
  workflow = { id: 'run', owner: 'alice', projectId: 'p', namespace: 'n', name: 'multipart', status: 'RUNNING',
    spec: parseWorkflowYaml(yaml).spec, specYaml: yaml, vars: {}, taskCount: 1, succeededCount: 0, failedCount: 0, createdAt: 'x', updatedAt: 'x' };
  await repo.putWorkflow(workflow);
  await repo.putTask({ workflowId: 'run', name: 'train', attempts: 1, attemptEpoch: 'epoch', phase: 'RUNNING', replicas: 1,
    outputPath: '/fsx/checkpoints/projects/p/runs/run/attempts/1/train', updatedAt: 'x' });
  broker = new RuntimeBroker({ repo, now: () => new Date(), signingKey: 's'.repeat(64), apiUrl: 'http://broker', artifactBucket: 'artifacts', storage });
  service = new CheckpointService(broker.deps, value => broker.authenticate(value));
  token = broker.environment(workflow, workflow.spec.workflow.tasks[0], 'epoch', 1).PAI_RUNTIME_TOKEN;
});
async function planned(payload = request()) {
  const registration = await service.plan(token, payload);
  if (!('publicationId' in registration)) throw new Error('missing v2 registration');
  return { publicationId: registration.publicationId!, path: 'model.bin' };
}
async function uploaded(payload = request()) {
  const ref = await planned(payload);
  const file = await service.files.file(token, ref);
  for (let number = 1; number <= file.partCount!; number++) {
    const checksumSHA256 = sha(`part-${number}`);
    await service.files.part(token, { ...ref, number, checksumSHA256 });
    parts.push({ number, size: Math.min(file.partSize!, payload.files[0].size - (number - 1) * file.partSize!),
      checksumSHA256, etag: `actual-s3-etag-${number}` });
  }
  return ref;
}

it('uses bounded descriptors for >5 GiB and reconciles a lost create reply without duplicate initiation', async () => {
  const ref = await planned(request(6 * 1024 ** 3));
  loseCreate = true;
  await expect(service.files.file(token, ref)).rejects.toThrow('ambiguous create');
  const resumed = await service.files.file(token, ref);
  expect(resumed).toMatchObject({ mode: 'MULTIPART', state: 'OPEN', partCount: 96, partSize: 64 * 1024 ** 2 });
  expect(multipart.create).toHaveBeenCalledTimes(1);
  expect(await activeUploads(broker.deps, 'run', 'epoch', 'train')).toEqual([ref.publicationId]);
});
it('pins part identity, refreshes signatures, and resumes only actual matching S3 parts', async () => {
  const ref = await planned(); await service.files.file(token, ref);
  const part = { ...ref, number: 1, checksumSHA256: sha('one') };
  await service.files.part(token, part); await service.files.part(token, part);
  expect(multipart.sign).toHaveBeenCalledTimes(2);
  parts.push({ number: 1, size: 64 * 1024 ** 2, etag: 'actual-s3-etag', checksumSHA256: part.checksumSHA256 });
  expect(await service.files.part(token, part)).toEqual({ state: 'UPLOADED', number: 1 });
  expect(multipart.sign).toHaveBeenCalledTimes(2);
  await expect(service.files.part(token, { ...part, checksumSHA256: sha('changed') })).rejects.toMatchObject({ status: 400 });
  parts[0].checksumSHA256 = sha('corrupt storage');
  await expect(service.files.part(token, part)).rejects.toMatchObject({ status: 409 });
});
it('uses server-listed ETags, adopts an ambiguous complete, independently hashes the pinned version and commits once', async () => {
  const ref = await uploaded();
  loseComplete = true;
  expect(await service.files.complete(token, ref, new AbortController().signal)).toMatchObject({ state: 'COMPLETE' });
  expect(multipart.complete).toHaveBeenCalledTimes(1);
  expect(vi.mocked(multipart.complete).mock.calls[0][3].map(part => part.etag)).toEqual(['actual-s3-etag-1', 'actual-s3-etag-2']);
  expect(multipart.sha256).toHaveBeenCalledWith('artifacts', key, 'pinned-version', request().files[0].size, expect.any(AbortSignal), expect.any(Function));
  const receipt = await service.complete(token, request());
  expect(receipt.state).toBe('READY');
  expect(await service.complete(token, request())).toEqual(receipt);
  expect(await service.plan(token, request())).toMatchObject({ state: 'READY', uploads: [] });
  expect(await activeUploads(broker.deps, 'run', 'epoch', 'train')).toEqual([]);
  const manifest = JSON.parse([...manifests.values()][0].body);
  expect(manifest.objects[0]).toMatchObject({ checksumSHA256: actualSHA, storageChecksumType: 'COMPOSITE',
    storageChecksumSHA256: objects.get(key)!.checksumSHA256, versionId: 'pinned-version' });
  expect(manifest.objects[0].checksumSHA256).not.toBe(manifest.objects[0].storageChecksumSHA256);
  expect(await service.files.abort(token, { publicationId: ref.publicationId })).toMatchObject({ state: 'READY' });
  expect(multipart.abort).not.toHaveBeenCalled(); expect(multipart.deleteVersion).not.toHaveBeenCalled();
});
it('restores the independently verified full checksum while checking the S3 composite version separately', async () => {
  const ref = await uploaded();
  await service.files.complete(token, ref, new AbortController().signal);
  await service.complete(token, request());
  const task = (await repo.listTasks('run'))[0];
  await repo.putTask({ ...task, attempts: 2, attemptEpoch: 'next', phase: 'INITIALIZING',
    outputPath: '/fsx/checkpoints/projects/p/runs/run/attempts/2/train',
    checkpointRestoreSources: [{ workflowId: 'run', task: 'train', attempt: 1, epoch: 'epoch' }],
  } as RecoveryTask);
  const current = broker.environment(workflow, workflow.spec.workflow.tasks[0], 'next', 2).PAI_RUNTIME_TOKEN;
  const result = await broker.checkpoints(current, 0);
  expect(result.checkpoints[0].files[0]).toMatchObject({ checksumSHA256: actualSHA, checksumType: 'FULL_OBJECT', versionId: 'pinned-version' });
  objects.get(key)!.checksumSHA256 = sha('changed composite') + '-2';
  await expect(broker.checkpoints(current, 0)).rejects.toMatchObject({ status: 409 });
});
it('rejects a false full-file SHA even when every declared part checksum matched S3', async () => {
  const payload = request(); payload.files[0].checksumSHA256 = sha('false whole-file digest');
  const ref = await uploaded(payload);
  await expect(service.files.complete(token, ref, new AbortController().signal)).rejects.toMatchObject({ status: 422 });
  await expect(service.complete(token, payload)).rejects.toMatchObject({ status: 409 });
  expect(manifests.size).toBe(0);
});
it('never completes missing or changed parts', async () => {
  const ref = await uploaded(); parts.pop();
  await expect(service.files.complete(token, ref, new AbortController().signal)).rejects.toMatchObject({ status: 409 });
  expect(multipart.complete).not.toHaveBeenCalled();
});
it('fences during whole-object verification, then permits only scoped abort and version cleanup', async () => {
  const ref = await uploaded();
  vi.mocked(multipart.sha256).mockImplementationOnce(async (_b, _k, _v, _s, _signal, check) => {
    await repo.kv.put({ pk: 'WF#run', sk: 'FENCE#epoch' });
    await check();
    return actualSHA;
  });
  await expect(service.files.complete(token, ref, new AbortController().signal)).rejects.toMatchObject({ status: 410 });
  expect(manifests.size).toBe(0);
  await expect(service.files.part(token, { ...ref, number: 1, checksumSHA256: sha('part-1') })).rejects.toMatchObject({ status: 410 });
  expect(await service.files.abort(token, { publicationId: ref.publicationId })).toEqual({ state: 'ABORTED', clean: true });
  expect(multipart.deleteVersion).toHaveBeenCalledWith('artifacts', key, 'pinned-version', undefined);
  expect(objects.size).toBe(0);
  expect(await activeUploads(broker.deps, 'run', 'epoch', 'train')).toEqual([]);
});
it('operator cleanup reconciles active uploads after token expiry without deleting a READY checkpoint', async () => {
  const ref = await uploaded();
  const future = new Date(Date.now() + 9 * 86400_000);
  broker.deps.now = () => future;
  await expect(broker.authenticate(token)).rejects.toMatchObject({ status: 410 });
  const plan = await repo.kv.get('WF#run', `RUNTIME#epoch#UPLOAD#${ref.publicationId}`) as Plan;
  const fileKey = uploadFileKey(plan, 'model.bin');
  await repo.kv.del(fileKey.pk, fileKey.sk); // Model TTL expiry of session metadata.
  expect(await cleanupCheckpointUploads(broker.deps, workflow, { signal: new AbortController().signal, taskNames: ['train'], attempt: 1 })).toBe(true);
  expect(multipart.abort).toHaveBeenCalledWith('artifacts', key, 's3-upload-id', expect.any(AbortSignal));
  const row = await repo.kv.get('WF#run', `RUNTIME#epoch#UPLOAD#${ref.publicationId}`) as Plan;
  expect(row.state).toBe('ABORTED');
});
it('repeating scoped abort removes a late uncommitted version and never reopens the publication', async () => {
  const ref = await uploaded();
  await service.files.abort(token, { publicationId: ref.publicationId });
  objects.set(key, { versionId: 'late-version', size: request().files[0].size, checksumSHA256: sha('composite') + '-2',
    checksumType: 'COMPOSITE', metadata: { 'pai-checkpoint-file': identity, 'pai-full-sha256': actualSHA } });
  expect(await service.files.abort(token, { publicationId: ref.publicationId })).toEqual({ state: 'ABORTED', clean: true });
  expect(objects.size).toBe(0);
  await expect(service.plan(token, request())).rejects.toMatchObject({ status: 410 });
});
it('does not claim cleanup while S3 still lists the multipart upload', async () => {
  const ref = await uploaded();
  vi.mocked(multipart.abort).mockImplementation(async () => {});
  expect(await cleanupCheckpointUploads(broker.deps, workflow, { signal: new AbortController().signal })).toBe(false);
  expect((await repo.kv.get('WF#run', `RUNTIME#epoch#UPLOAD#${ref.publicationId}`))?.state).toBe('ABORTING');
  vi.mocked(multipart.abort).mockImplementation(async () => { ids = []; });
  expect(await cleanupCheckpointUploads(broker.deps, workflow, { signal: new AbortController().signal })).toBe(true);
});
it('keeps incomplete verification resumable after request cancellation without completing S3 twice', async () => {
  const ref = await uploaded(), controller = new AbortController();
  vi.mocked(multipart.sha256).mockImplementationOnce(async () => { controller.abort(); controller.signal.throwIfAborted(); return actualSHA; });
  await expect(service.files.complete(token, ref, controller.signal)).rejects.toThrow();
  service = new CheckpointService(broker.deps, value => broker.authenticate(value));
  expect(await service.files.complete(token, ref, new AbortController().signal)).toMatchObject({ state: 'COMPLETE' });
  expect(multipart.complete).toHaveBeenCalledTimes(1);
  const plan = await service.registered(await broker.authenticate(token), ref.publicationId);
  const file = await repo.kv.get(plan.pk, uploadFileKey(plan, 'model.bin').sk) as UploadFile;
  expect(file.storageChecksumType).toBe('COMPOSITE');
});
it('serves the old client exact uploads JSON through HTTP, accepts its completion, and requires explicit v2 for new endpoints', async () => {
  const handle = createRuntimeHandler(broker);
  const server: Server = createServer((req, res) => { void handle(req, res); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = (path: string, body: unknown) => fetch(origin + path, { method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const legacy = { purpose: 'checkpoint', destination: request().destination,
      files: [{ path: 'legacy.bin', size: 3, checksumSHA256: sha('abc') }] };
    const response = await post('/runtime/uploads', legacy);
    expect(response.status).toBe(200);
    const plan = await response.json();
    expect(Object.keys(plan)).toEqual(['uploads']);
    expect(plan.uploads).toHaveLength(1);
    expect(Object.keys(plan.uploads[0]).sort()).toEqual(['headers', 'path', 'url']);
    const objectKey = new URL(plan.uploads[0].url).pathname.slice(1);
    objects.set(objectKey, { size: 3, versionId: 'legacy-version', checksumSHA256: sha('abc'), checksumType: 'FULL_OBJECT' });
    const completion = await post('/runtime/uploads/complete', legacy);
    expect(completion.status).toBe(200);
    expect((await completion.json()).state).toBe('READY');
    expect((await post('/runtime/uploads', { ...legacy, files: [{ ...legacy.files[0], size: 6 * 1024 ** 3 }] })).status).toBe(400);
    const oldId = objectKey.split('/').at(-3)!;
    expect((await post('/runtime/uploads/file', { publicationId: oldId, path: 'legacy.bin' })).status).toBe(400);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
