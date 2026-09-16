import { beforeEach, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { Repo } from '../store/repo';
import { MemoryKV } from '../store/dynamo';
import { parseWorkflowYaml } from '../workflow/template';
import type { Workflow } from '../store/types';
import { RuntimeBroker } from './broker';
import type { ObjectStorage } from './storage';
const checksum = createHash('sha256').update('abc').digest('base64');
let repo: Repo, broker: RuntimeBroker, wf: Workflow, token: string, objects: Map<string, {
    size: number;
    checksumSHA256: string;
    checksumType?: 'FULL_OBJECT' | 'COMPOSITE';
    versionId: string;
  }>, manifests: Map<string, {
    body: string;
    versionId: string;
  }>, signed: string[], store: ObjectStorage;
const request = {
  purpose: 'checkpoint',
  destination: 's3://artifacts/projects/p/checkpoints/',
  files: [{
    path: 'weights/model.pt',
    size: 3,
    checksumSHA256: checksum
  }]
};
beforeEach(async () => {
  repo = new Repo(new MemoryKV());
  objects = new Map();
  manifests = new Map();
  signed = [];
  store = {
    presignPut: async (_b, key, file) => {
      signed.push(key);
      return {
        url: `https://upload.invalid/${key}`,
        headers: {
          'x-amz-checksum-sha256': file.checksumSHA256
        }
      };
    },
    head: async (_b, key, version) => {
      const object = objects.get(key);
      if (!object || version && object.versionId !== version) throw new Error('not found');
      return object;
    },
    readManifest: async (_b, key) => manifests.get(key),
    writeManifest: async (_b, key, body) => {
      if (!manifests.has(key)) manifests.set(key, {
        body,
        versionId: 'manifest-v1'
      });
      return manifests.get(key)!;
    },
    presignGet: async (_b, key, version) => `https://download.invalid/${key}?versionId=${version}`
  };
  const yaml = `workflow:\n  name: w\n  resources: {cpu: {cpu: 1}}\n  tasks:\n    - name: train\n      resource: cpu\n      image: busybox\n      command: [echo, x]\n      checkpoint: [{path: /checkpoints, url: 's3://artifacts/projects/p/checkpoints/', frequency: 30s}]\n`;
  wf = {
    id: 'run',
    projectId: 'p',
    namespace: 'n',
    owner: 'a',
    name: 'w',
    status: 'RUNNING',
    spec: parseWorkflowYaml(yaml).spec,
    specYaml: yaml,
    vars: {},
    createdAt: 'x',
    updatedAt: 'x',
    taskCount: 1,
    succeededCount: 0,
    failedCount: 0
  };
  await repo.putWorkflow(wf);
  await repo.putTask({
    workflowId: 'run',
    name: 'train',
    attemptEpoch: 'epoch',
    attempts: 1,
    phase: 'RUNNING',
    replicas: 1,
    updatedAt: 'x'
  });
  broker = new RuntimeBroker({
    repo,
    now: () => new Date('2026-09-16T00:00:00Z'),
    signingKey: 'a'.repeat(64),
    apiUrl: 'http://worker',
    artifactBucket: 'artifacts',
    storage: store
  });
  token = broker.environment(wf, wf.spec.workflow.tasks[0], 'epoch', 1).PAI_RUNTIME_TOKEN;
});
it('authorizes declared destination and safe unique paths before issuing fixed-prefix PUTs', async () => {
  await expect(broker.planUploads(token, {
    ...request,
    destination: 's3://artifacts/projects/other/checkpoints/'
  })).rejects.toMatchObject({
    status: 403
  });
  for (const path of ['../escape', '/absolute', 'a/../../b', 'a\\b', 'a/%2e%2e/b']) await expect(broker.planUploads(token, {
    ...request,
    files: [{
      ...request.files[0],
      path
    }]
  })).rejects.toMatchObject({
    status: 400
  });
  await expect(broker.planUploads(token, {
    ...request,
    files: [request.files[0], request.files[0]]
  })).rejects.toMatchObject({
    status: 400
  });
  expect(signed).toEqual([]);
  const plan = await broker.planUploads(token, request);
  expect(plan.uploads).toHaveLength(1);
  expect(signed[0]).toMatch(/^projects\/p\/runs\/run\/attempts\/1\/checkpoints\/train\/[a-f0-9]+\/objects\/weights\/model.pt$/);
});
it('requires all object versions/checksums before publishing an immutable manifest and idempotent receipt', async () => {
  await broker.planUploads(token, request);
  await expect(broker.completeUploads(token, request)).rejects.toThrow();
  objects.set(signed[0], {
    size: 3,
    checksumSHA256: 'wrong',
    versionId: 'v1'
  });
  await expect(broker.completeUploads(token, request)).rejects.toMatchObject({
    status: 409
  });
  expect(manifests.size).toBe(0);
  objects.set(signed[0], {
    size: 3,
    checksumSHA256: checksum,
    versionId: 'v1'
  });
  const result = await broker.completeUploads(token, request);
  expect(result.state).toBe('READY');
  expect(result.objectCount).toBe(1);
  expect((await broker.completeUploads(token, request)).manifestUri).toBe(result.manifestUri);
  expect(manifests.size).toBe(1);
});
it('does not commit READY if epoch is fenced during S3 verification', async () => {
  await broker.planUploads(token, request);
  objects.set(signed[0], {
    size: 3,
    checksumSHA256: checksum,
    versionId: 'v1'
  });
  const head = store.head;
  store.head = async (...args) => {
    await repo.kv.put({
      pk: 'WF#run',
      sk: 'FENCE#epoch'
    });
    return head(...args);
  };
  await expect(broker.completeUploads(token, request)).rejects.toMatchObject({
    status: 410
  });
  expect((await repo.kv.query('WF#run', 'RUNTIME#epoch#UPLOAD#')).some(row => row.state === 'READY')).toBe(false);
});
it('rejects invalid checksums, excessive sizes and completion without a durable upload plan', async () => {
  await expect(broker.planUploads(token, {
    ...request,
    files: [{
      ...request.files[0],
      size: 5 * 1024 ** 3 + 1
    }]
  })).rejects.toMatchObject({
    status: 400
  });
  await expect(broker.planUploads(token, {
    ...request,
    files: [{
      ...request.files[0],
      checksumSHA256: 'not-base64'
    }]
  })).rejects.toMatchObject({
    status: 400
  });
  await expect(broker.completeUploads(token, request)).rejects.toMatchObject({
    status: 409
  });
});
it('serves only checksum-pinned input manifests and immutable object versions', async () => {
  const inputKey = 'projects/p/datasets/data/v1/manifest.json';
  const objectKey = 'projects/p/datasets/data/v1/files/data.bin';
  const body = JSON.stringify({
    projectId: 'p',
    objects: [{
      key: objectKey,
      versionId: 'input-v1',
      bytes: 3,
      checksumSHA256: checksum
    }]
  });
  const manifestHash = createHash('sha256').update(body).digest('hex');
  wf.spec.workflow.tasks[0].inputs = [{
    dataset: {
      name: 'data',
      version: 1
    }
  }];
  wf.datasetSnapshots = {
    train: {
      0: {
        name: 'data',
        version: 1,
        fsxPath: '/fsx/datasets/projects/p/data/v1',
        uri: 's3://artifacts/projects/p/datasets/data/v1/',
        manifestHash
      }
    }
  };
  await repo.putWorkflow(wf);
  await repo.putVersion({
    dataset: 'data',
    projectId: 'p',
    version: 1,
    uri: wf.datasetSnapshots.train[0].uri,
    fsxPath: wf.datasetSnapshots.train[0].fsxPath,
    manifestUri: `s3://artifacts/${inputKey}`,
    manifestHash,
    tags: [],
    createdAt: 'x',
    createdBy: 'a',
    state: 'READY'
  });
  manifests.set(inputKey, {
    body,
    versionId: 'manifest-v1'
  });
  objects.set(objectKey, {
    versionId: 'input-v1',
    size: 3,
    checksumSHA256: checksum
  });
  const response = await broker.inputs(token);
  expect(response.inputs[0].fsxPath).toBe('/fsx/datasets/projects/p/data/v1');
  expect(response.inputs[0].files[0].url).toContain('versionId=input-v1');
  expect(response.inputs[0].files[0].path).toBe('files/data.bin');
  const originalPath = wf.datasetSnapshots.train[0].fsxPath;
  wf.datasetSnapshots.train[0].fsxPath = '/fsx/datasets/projects/p/../other/data';
  await repo.putWorkflow(wf);
  await expect(broker.inputs(token)).rejects.toMatchObject({
    status: 409
  });
  wf.datasetSnapshots.train[0].fsxPath = originalPath;
  await repo.putWorkflow(wf);
  manifests.set(inputKey, {
    body: body + ' ',
    versionId: 'manifest-v2'
  });
  await expect(broker.inputs(token)).rejects.toMatchObject({
    status: 409
  });
});
it('adopts and verifies an immutable manifest after a lost publication reply', async () => {
  await broker.planUploads(token, request);
  objects.set(signed[0], {
    size: 3,
    checksumSHA256: checksum,
    versionId: 'v1'
  });
  const write = store.writeManifest;
  let first = true;
  store.writeManifest = async (...args) => {
    const result = await write(...args);
    if (first) {
      first = false;
      throw new Error('lost reply');
    }
    return result;
  };
  await expect(broker.completeUploads(token, request)).rejects.toThrow('lost reply');
  expect((await repo.kv.query('WF#run', 'RUNTIME#epoch#UPLOAD#'))[0].state).toBe('PENDING');
  expect((await broker.completeUploads(token, request)).state).toBe('READY');
  expect(manifests.size).toBe(1);
});
it('rejects declared dataset inputs without immutable snapshots instead of returning an empty hydration plan', async () => {
  wf.spec.workflow.tasks[0].inputs = [{
    dataset: {
      name: 'missing',
      version: 1
    }
  }];
  await repo.putWorkflow(wf);
  await expect(broker.inputs(token)).rejects.toMatchObject({
    status: 409
  });
});
it.each(['FULL_OBJECT', 'COMPOSITE'] as const)('consumes schemaVersion 1 snapshots with %s checksums without inventing whole-file hashes', async checksumType => {
  const digest = checksumType === 'COMPOSITE' ? checksum + '-2' : checksum;
  const manifestKey = 'projects/p/datasets/data/v1/manifest.json',
    key = 'projects/p/datasets/data/v1/data.bin';
  const body = JSON.stringify({
    schemaVersion: 1,
    identity: 'dataset:data:v1',
    createdAt: '2026-09-16T00:00:00Z',
    source: {
      bucket: 'source',
      prefix: 'original/'
    },
    objects: [{
      path: 'data.bin',
      key,
      versionId: 'input-v1',
      bytes: 3,
      checksumSHA256: digest,
      checksumType
    }]
  });
  const manifestHash = createHash('sha256').update(body).digest('hex');
  wf.spec.workflow.tasks[0].inputs = [{
    dataset: {
      name: 'data',
      version: 1
    }
  }];
  wf.datasetSnapshots = {
    train: {
      0: {
        name: 'data',
        version: 1,
        fsxPath: '/fsx/datasets/projects/p/data/v1',
        uri: 's3://artifacts/projects/p/datasets/data/v1/',
        manifestHash
      }
    }
  };
  await repo.putWorkflow(wf);
  await repo.putVersion({
    dataset: 'data',
    projectId: 'p',
    version: 1,
    uri: wf.datasetSnapshots.train[0].uri,
    manifestUri: `s3://artifacts/${manifestKey}`,
    manifestHash,
    tags: [],
    createdAt: 'x',
    createdBy: 'a',
    state: 'READY'
  });
  manifests.set(manifestKey, {
    body,
    versionId: 'm1'
  });
  objects.set(key, {
    versionId: 'input-v1',
    size: 3,
    checksumSHA256: digest,
    checksumType
  });
  const result = await broker.inputs(token);
  expect(result.inputs[0].files[0]).toMatchObject({
    path: 'data.bin',
    size: 3,
    checksumSHA256: digest,
    checksumType
  });
  objects.set(key, {
    versionId: 'input-v1',
    size: 3,
    checksumSHA256: digest,
    checksumType: checksumType === 'COMPOSITE' ? 'FULL_OBJECT' : 'COMPOSITE'
  });
  await expect(broker.inputs(token)).rejects.toMatchObject({
    status: 409
  });
});
it('never treats a composite S3 checksum as whole-file proof for checkpoint publication', async () => {
  await broker.planUploads(token, request);
  objects.set(signed[0], {
    size: 3,
    versionId: 'v1',
    checksumSHA256: checksum,
    checksumType: 'COMPOSITE'
  });
  await expect(broker.completeUploads(token, request)).rejects.toMatchObject({
    status: 409
  });
  expect(manifests.size).toBe(0);
});
