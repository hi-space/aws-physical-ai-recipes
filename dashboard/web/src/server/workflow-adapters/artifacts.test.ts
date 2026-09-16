import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ fsx: vi.fn(), s3: vi.fn(), json: vi.fn(), request: vi.fn() }));
vi.mock('../aws/clients', () => ({ fsx: () => ({ send: mocks.fsx }), s3: () => ({ send: mocks.s3 }) }));
vi.mock('../config', () => ({ config: () => ({ eks: { fsxFileSystemId: 'fs-one', dataBucket: 'mirror' } }) }));
vi.mock('../k8s/client', () => ({ k8sJson: mocks.json, k8sRequest: mocks.request }));
import { artifactPublisher, cancelArtifactCollectors, publicationPrefix } from './artifacts';
import { INVENTORY_PYTHON, inventoryName, inventoryRecord } from './artifact-inventory';
import { Repo, setRepoForTests } from '../store/repo';
import { MemoryKV } from '../store/dynamo';
import { workflowSchema } from '../workflow/schema';
import type { ControllerDeps } from '../workflow/ports';
type Input = Parameters<NonNullable<ControllerDeps['artifactPublisher']>['publish']>[0];
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const checksum = (text: string) => createHash('sha256').update(text).digest('base64');
const absent = () => Object.assign(new Error('missing'), { name: 'NoSuchKey', status: 404 });
interface Stored { body: string; version: string }
let input: Input, repo: Repo, temp: string, log: string;
let job: any, pods: any[], holdCleanup: boolean, auto: boolean, failedExport: boolean;
let objects: Map<string, Stored>, version: number;
const mirrorPrefix = 'checkpoints/projects/p/runs/run/attempts/1/produce/';
const sourceFiles = new Map([['result.json', '{"applicationExit":7}'], ['final/model.zip', 'real fixture checkpoint bytes']]);
function exportFiles() { for (const [path, body] of sourceFiles) objects.set(`mirror/${mirrorPrefix}${path}`, { body, version: `mirror-${++version}` }); }
function finishCollector() {
  job.status = { succeeded: 1 };
  pods = [{ metadata: { name: job.metadata.name + '-pod', uid: 'pod-uid', labels: job.spec.template.metadata.labels,
    ownerReferences: [{ uid: job.metadata.uid, controller: true }] }, spec: structuredClone(job.spec.template.spec),
    status: { phase: 'Succeeded', containerStatuses: [{ name: 'inventory', state: { terminated: { exitCode: 0 } } }],
      initContainerStatuses: [{ name: 'verify-source', state: { terminated: { exitCode: 0 } } }] } }];
}
beforeEach(async () => {
  vi.stubEnv('MUJOCO_IMAGE_URI', 'registry/mujoco:verified'); vi.stubEnv('DASHBOARD_ARTIFACT_BUCKET', 'archive');
  repo = new Repo(new MemoryKV()); setRepoForTests(repo);
  input = {
    workflow: {
      id: 'run', name: 'run', namespace: 'hyperpod-ns-p', projectId: 'p', owner: 'alice', status: 'FINALIZING',
      spec: workflowSchema.parse({ workflow: { name: 'run', queue: 'project-queue', resources: { cpu: { cpu: 1 } },
        tasks: [{ name: 'produce', resource: 'cpu', image: 'application', command: ['true'], exitActions: { COMPLETE: 7 } }] } }),
      specYaml: '', vars: {}, createdAt: '', updatedAt: '', taskCount: 1, succeededCount: 0, failedCount: 0,
    },
    task: { workflowId: 'run', name: 'produce', phase: 'FINALIZING', attempts: 1, replicas: 1, attemptEpoch: 'epoch-one',
      outputPath: '/fsx/checkpoints/projects/p/runs/run/attempts/1/produce', updatedAt: '', exitCode: 7, wrapperExitCode: 0 },
    output: { dataset: { name: 'output-run', path: '{{output}}' } }, sourcePath: '/fsx/checkpoints/projects/p/runs/run/attempts/1/produce',
    publicationId: 'run:produce:0', attempt: 1, signal: new AbortController().signal,
  };
  await repo.putWorkflow(input.workflow); await repo.putTask(input.task);
  temp = mkdtempSync(join(tmpdir(), 'pai-publisher-')); mkdirSync(join(temp, 'final'));
  for (const [path, body] of sourceFiles) writeFileSync(join(temp, path), body);
  log = execFileSync('python3', ['-I', '-B', '-c', INVENTORY_PYTHON, temp, `workflow:${input.publicationId}:1`, 'produce'], { encoding: 'utf8' });
  job = undefined; pods = []; holdCleanup = false; auto = true; failedExport = false; objects = new Map(); version = 0;
  mocks.fsx.mockReset().mockImplementation(async command => {
    if (command.constructor.name === 'DescribeDataRepositoryAssociationsCommand') return { Associations: [{
      FileSystemId: 'fs-one', AssociationId: 'dra-auto', FileSystemPath: '/checkpoints', DataRepositoryPath: 's3://mirror/checkpoints/',
      Lifecycle: 'AVAILABLE', S3: { AutoExportPolicy: { Events: auto ? ['NEW', 'CHANGED', 'DELETED'] : [] } },
    }] };
    if (command.constructor.name === 'CreateDataRepositoryTaskCommand') {
      if (auto) throw new Error('Export tasks are not supported for data repositories with Automatic Export enabled');
      return { DataRepositoryTask: { TaskId: 'export-task' } };
    }
    if (command.constructor.name === 'DescribeDataRepositoryTasksCommand') return { DataRepositoryTasks: [{ TaskId: 'export-task', Lifecycle: 'SUCCEEDED', Status: { FailedCount: failedExport ? 1 : 0 } }] };
    throw new Error(`Unexpected FSx command ${command.constructor.name}`);
  });
  mocks.json.mockReset().mockImplementation(async (path: string, init: any = {}) => {
    if (path.includes('/jobs')) {
      if (init.method === 'POST') { job = structuredClone(init.body); job.metadata.uid = 'job-uid'; return structuredClone(job); }
      if (init.method === 'DELETE') { if (!holdCleanup) job = undefined; return {}; }
      if (!job) throw absent(); return structuredClone(job);
    }
    if (path.includes('/pods')) {
      if (init.method === 'DELETE') { if (!holdCleanup) pods = []; return {}; }
      return { items: structuredClone(pods) };
    }
    throw new Error(`Unexpected K8s path ${path}`);
  });
  mocks.request.mockReset().mockImplementation(async () => new Response(log));
  mocks.s3.mockReset().mockImplementation(async command => {
    const arg = command.input; const key = `${arg.Bucket}/${arg.Key}`;
    switch (command.constructor.name) {
      case 'HeadObjectCommand': {
        const object = objects.get(key); if (!object || arg.VersionId && arg.VersionId !== object.version) throw absent();
        return { VersionId: object.version, ETag: '"etag"', ContentLength: Buffer.byteLength(object.body),
          ChecksumSHA256: checksum(object.body), ChecksumType: 'FULL_OBJECT' };
      }
      case 'GetObjectCommand': {
        const object = objects.get(key); if (!object || arg.VersionId && arg.VersionId !== object.version) throw absent();
        const body = Readable.from([Buffer.from(object.body)]) as any; body.transformToString = async () => object.body;
        return { VersionId: object.version, ContentLength: Buffer.byteLength(object.body), Body: body };
      }
      case 'PutObjectCommand': {
        if (objects.has(key) && arg.IfNoneMatch) throw Object.assign(new Error('exists'), { name: 'PreconditionFailed' });
        const item = { body: String(arg.Body), version: `archive-${++version}` }; objects.set(key, item); return { VersionId: item.version };
      }
      case 'CopyObjectCommand': {
        const [rawSource, query] = arg.CopySource.split('?'); const object = objects.get(decodeURIComponent(rawSource));
        if (!object || new URLSearchParams(query).get('versionId') !== object.version) throw absent();
        const copied = { ...object, version: `archive-${++version}` }; objects.set(key, copied); return { VersionId: copied.version };
      }
      case 'ListObjectsV2Command': throw new Error('Listing is not trusted output evidence');
      default: throw new Error(`Unexpected S3 command ${command.constructor.name}`);
    }
  });
});
afterEach(() => { if (temp) rmSync(temp, { force: true, recursive: true }); vi.unstubAllEnvs(); });
const manifestKey = () => `archive/${publicationPrefix(input)}manifest.json`;
const createCalls = () => mocks.json.mock.calls.filter(([, init]) => init?.method === 'POST').length;

describe('artifact publisher with existing AutoExport', () => {
  it('allows only one in-flight create while another reconciler sees no Job yet', async () => {
    const original = mocks.json.getMockImplementation()!;
    let release!: () => void, created!: () => void, posts = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { created = resolve; });
    mocks.json.mockImplementation(async (path, init) => {
      if (init?.method === 'POST') { posts++; created(); await gate; }
      return original(path, init);
    });
    const first = artifactPublisher.publish(input);
    try {
      await started;
      expect(await artifactPublisher.publish(input)).toMatchObject({ state: 'pending' });
      expect(posts).toBe(1);
    } finally { release(); }
    expect(await first).toMatchObject({ state: 'pending' });
  });
  it('collects actual bytes, waits for all exports, excludes extras and pins a replayable snapshot', async () => {
    expect(await artifactPublisher.publish(input)).toMatchObject({ state: 'pending' });
    expect(createCalls()).toBe(1); expect(job.metadata.name).toBe(inventoryName(input)); finishCollector();
    expect(await artifactPublisher.publish(input)).toMatchObject({ state: 'pending', message: expect.stringContaining('AutoExport') });
    expect(job).toBeUndefined(); expect(pods).toEqual([]); expect(objects.has(manifestKey())).toBe(false);
    exportFiles(); objects.delete(`mirror/${mirrorPrefix}final/model.zip`);
    expect(await artifactPublisher.publish(input)).toMatchObject({ state: 'pending' });
    exportFiles(); objects.set(`mirror/${mirrorPrefix}final/model.zip`, { body: sourceFiles.get('final/model.zip')!.replace('real', 'FAKE'), version: 'stale-version' });
    expect(await artifactPublisher.publish(input)).toMatchObject({ state: 'pending', message: expect.stringContaining('SHA256') });
    expect(objects.has(manifestKey())).toBe(false);
    exportFiles(); objects.set(`mirror/${mirrorPrefix}unrelated`, { body: 'excluded', version: 'v' });
    const result = await artifactPublisher.publish(input);
    expect(result).toMatchObject({ state: 'ready', objectCount: 2 });
    const manifest = JSON.parse(objects.get(manifestKey())!.body);
    expect(manifest.objects.map((object: any) => object.path)).toEqual(['final/model.zip', 'result.json']);
    expect(result.state === 'ready' && result.manifestHash).toBe(hash(objects.get(manifestKey())!.body));
    expect(createCalls()).toBe(1);
    expect(mocks.fsx.mock.calls.every(([command]) => command.constructor.name === 'DescribeDataRepositoryAssociationsCommand')).toBe(true);
    expect(mocks.s3.mock.calls.some(([command]) => command.constructor.name === 'ListObjectsV2Command')).toBe(false);
    expect(await artifactPublisher.publish(input)).toEqual(result);
  });
  it('does not return READY while collector deletion is pending', async () => {
    await artifactPublisher.publish(input); finishCollector(); exportFiles(); holdCleanup = true;
    expect(await artifactPublisher.publish(input)).toMatchObject({ state: 'pending' });
    expect(objects.has(manifestKey())).toBe(false); expect(job).toBeDefined(); holdCleanup = false;
    expect(await artifactPublisher.publish(input)).toMatchObject({ state: 'ready' }); expect(pods).toEqual([]);
  });
  it('fences cancellation and waits for both Job and Pod deletion', async () => {
    await artifactPublisher.publish(input); finishCollector(); holdCleanup = true;
    expect(await cancelArtifactCollectors(input.workflow, { signal: input.signal, taskNames: ['produce'], attempt: 1 })).toBe(false);
    await expect(artifactPublisher.publish(input)).rejects.toThrow(/fenced/); holdCleanup = false;
    expect(await cancelArtifactCollectors(input.workflow, { signal: input.signal, taskNames: ['produce'], attempt: 1 })).toBe(true);
    expect(job).toBeUndefined(); expect(pods).toEqual([]); expect(createCalls()).toBe(1);
  });
  it('rejects cancellation before any FSx or Kubernetes call', async () => {
    await repo.requestCancellation('run', 'alice', new Date().toISOString());
    await expect(artifactPublisher.publish(input)).rejects.toThrow(/cancelled/);
    expect(mocks.fsx).not.toHaveBeenCalled(); expect(mocks.json).not.toHaveBeenCalled();
  });
  it('rejects a superseded attempt', async () => {
    await repo.putTask({ ...input.task, attempts: 2 });
    await expect(artifactPublisher.publish(input)).rejects.toThrow(/superseded/); expect(mocks.fsx).not.toHaveBeenCalled();
  });
  it.each(['command', 'mount', 'volume', 'uid', 'privileged', 'env', 'root'])('rejects a changed collector %s', async kind => {
    await artifactPublisher.publish(input); finishCollector();
    if (kind === 'command') job.spec.template.spec.containers[0].command = ['echo', 'invented'];
    if (kind === 'mount') job.spec.template.spec.containers[0].volumeMounts[0].subPath = 'other-project';
    if (kind === 'volume') job.spec.template.spec.volumes[0].persistentVolumeClaim.claimName = 'different-pvc';
    if (kind === 'uid') job.metadata.uid = 'replacement';
    if (kind === 'privileged') job.spec.template.spec.containers[0].securityContext.privileged = true;
    if (kind === 'env') job.spec.template.spec.containers[0].env = [{ name: 'LD_PRELOAD', value: '/input/user.so' }];
    if (kind === 'root') job.spec.template.spec.containers[0].securityContext.runAsUser = 0;
    await expect(artifactPublisher.publish(input)).rejects.toThrow(/Collector/); expect(objects.has(manifestKey())).toBe(false);
  });
  it('rejects forged Pod ownership and substituted Pod commands', async () => {
    await artifactPublisher.publish(input); finishCollector(); pods[0].metadata.ownerReferences[0].uid = 'foreign';
    await expect(artifactPublisher.publish(input)).rejects.toThrow(/owned successful Pod/);
    finishCollector(); pods[0].spec.containers[0].command = ['echo'];
    await expect(artifactPublisher.publish(input)).rejects.toThrow(/trusted command/);
  });
  it('rejects truncated logs and unversioned inventory archives', async () => {
    await artifactPublisher.publish(input); finishCollector(); const original = log; log = log.slice(0, -2);
    await expect(artifactPublisher.publish(input)).rejects.toThrow(/Incomplete/); log = original;
    const send = mocks.s3.getMockImplementation()!;
    mocks.s3.mockImplementation(async (command, ...args) => { const result = await send(command, ...args);
      if (command.constructor.name === 'PutObjectCommand') result.VersionId = 'null'; return result; });
    await expect(artifactPublisher.publish(input)).rejects.toThrow(/versioning/); expect(objects.has(manifestKey())).toBe(false);
  });
  it('waits out a lost create reply before reporting cancellation complete', async () => {
    const original = mocks.json.getMockImplementation()!;
    mocks.json.mockImplementation(async (path, init) => { if (init?.method === 'POST') throw new Error('create response lost'); return original(path, init); });
    await expect(artifactPublisher.publish(input)).rejects.toThrow('create response lost');
    expect(await cancelArtifactCollectors(input.workflow, { signal: input.signal })).toBe(false);
    const key = inventoryRecord(input); const record = (await repo.kv.get(key.pk, key.sk))!;
    await repo.kv.put({ ...record, creationDeadline: Date.now() - 1 });
    expect(await cancelArtifactCollectors(input.workflow, { signal: input.signal })).toBe(true);
    await expect(artifactPublisher.publish(input)).rejects.toThrow(/fenced/);
  });
  it('retains manual exports and inventory verification when AutoExport is disabled', async () => {
    auto = false; await artifactPublisher.publish(input); finishCollector(); exportFiles();
    expect(await artifactPublisher.publish(input)).toMatchObject({ state: 'pending' });
    expect(mocks.fsx.mock.calls.some(([command]) => command.constructor.name === 'CreateDataRepositoryTaskCommand')).toBe(true);
    expect(await artifactPublisher.publish(input)).toMatchObject({ state: 'ready', objectCount: 2 });
  });
  it('rejects failed files in a completed manual export', async () => {
    auto = false; await artifactPublisher.publish(input); finishCollector(); exportFiles();
    await artifactPublisher.publish(input); failedExport = true;
    await expect(artifactPublisher.publish(input)).rejects.toThrow(/failed to export/); expect(objects.has(manifestKey())).toBe(false);
  });
});
