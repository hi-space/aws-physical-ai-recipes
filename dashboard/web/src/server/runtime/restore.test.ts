import { beforeEach, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { MemoryKV } from '../store/dynamo';
import { Repo } from '../store/repo';
import type { Workflow } from '../store/types';
import { parseWorkflowYaml } from '../workflow/template';
import type { RecoveryTask, RecoveryWorkflow } from '../workflow/checkpoints';
import { RuntimeBroker } from './broker';
import type { ObjectStorage, StoredManifest } from './storage';

let repo: Repo, broker: RuntimeBroker, workflow: RecoveryWorkflow, token: string, now: Date;
let objects: Map<string, { versionId: string; size: number; checksumSHA256: string }>;
let manifests: Map<string, StoredManifest>, gets: { key: string; version: string }[], manifestVersions: (string | undefined)[];
let store: ObjectStorage;
const checksum = (text: string) => createHash('sha256').update(text).digest('base64');
const destination = 's3://artifacts/projects/p/runs/run/checkpoints/train/0/';
const request = (text: string) => ({ purpose: 'checkpoint', destination, files: [{ path: 'final/model.bin', size: Buffer.byteLength(text), checksumSHA256: checksum(text) }] });

beforeEach(async () => {
  repo = new Repo(new MemoryKV()); objects = new Map(); manifests = new Map(); gets = []; manifestVersions = [];
  now = new Date('2026-09-16T00:00:00Z');
  store = {
    presignPut: async (_bucket, key) => ({ url: `https://put.invalid/${key}`, headers: {} }),
    head: async (_bucket, key, version) => {
      const value = objects.get(key);
      if (!value || version && value.versionId !== version) throw new Error('immutable version missing');
      return { ...value, checksumType: 'FULL_OBJECT' };
    },
    readManifest: async (_bucket, key, _signal, version) => {
      manifestVersions.push(version);
      const value = manifests.get(key);
      if (version && value?.versionId !== version) throw new Error('manifest version missing');
      return value;
    },
    writeManifest: async (_bucket, key, body) => {
      const value = manifests.get(key) ?? { body, versionId: `manifest-${manifests.size + 1}` };
      manifests.set(key, value); return value;
    },
    presignGet: async (_bucket, key, version) => { gets.push({ key, version }); return `https://get.invalid/${key}?versionId=${version}`; },
  };
  const yaml = 'workflow:\n  name: recovery\n  resources: {cpu: {cpu: 1}}\n  tasks:\n    - name: train\n      resource: cpu\n      image: python\n      command: [python, train.py]\n      checkpoint: [{path: "{{output}}", url: auto, frequency: 1s}]\n';
  workflow = { id: 'run', owner: 'alice', ownerSubject: 'alice-id', projectId: 'p', namespace: 'n',
    name: 'recovery', status: 'RUNNING', spec: parseWorkflowYaml(yaml).spec, specYaml: yaml, vars: {},
    createdAt: now.toISOString(), updatedAt: now.toISOString(), taskCount: 1, succeededCount: 0, failedCount: 0 };
  await repo.putWorkflow(workflow);
  await repo.putTask({ workflowId: 'run', name: 'train', attempts: 1, attemptEpoch: 'epoch-1', phase: 'RUNNING',
    replicas: 1, outputPath: '/fsx/checkpoints/projects/p/runs/run/attempts/1/train', updatedAt: now.toISOString() });
  broker = new RuntimeBroker({ repo, now: () => now, signingKey: 'x'.repeat(64), apiUrl: 'http://broker', artifactBucket: 'artifacts', storage: store });
  token = broker.environment(workflow, workflow.spec.workflow.tasks[0], 'epoch-1', 1).PAI_RUNTIME_TOKEN;
});

async function commit(text: string) {
  const plan = await broker.planUploads(token, request(text));
  const key = new URL(plan.uploads[0].url).pathname.slice(1);
  objects.set(key, { versionId: `object-${objects.size + 1}`, size: Buffer.byteLength(text), checksumSHA256: checksum(text) });
  return broker.completeUploads(token, request(text));
}
async function nextAttempt(manual = false) {
  const previous = (await repo.listTasks('run'))[0] as RecoveryTask;
  if (manual) {
    await repo.putWorkflow({ ...workflow, status: 'FAILED' });
    workflow = { ...workflow, id: 'retry-run', status: 'RUNNING', retryOf: 'run' };
    await repo.putWorkflow(workflow);
  }
  const attempts = manual ? 1 : 2;
  const task: RecoveryTask = { ...previous, workflowId: workflow.id, phase: 'LAUNCHING', attempts, attemptEpoch: 'epoch-new',
    outputPath: `/fsx/checkpoints/projects/p/runs/${workflow.id}/attempts/${attempts}/train`,
    checkpointRestoreSources: [{ workflowId: 'run', task: 'train', attempt: 1, epoch: 'epoch-1' }] };
  await repo.putTask(task);
  return broker.environment(workflow, workflow.spec.workflow.tasks[0], 'epoch-new', attempts).PAI_RUNTIME_TOKEN;
}

it('restores only READY checkpoint data with the pinned manifest/object versions using a new capability', async () => {
  const committed = await commit('committed');
  now = new Date(now.getTime() + 1000);
  await broker.planUploads(token, request('pending-newer'));
  now = new Date(now.getTime() + 2 * 86400_000); // Source capability has also expired.
  const current = await nextAttempt();
  await expect(broker.heartbeat(token)).rejects.toMatchObject({ status: 410 });
  const result = await broker.checkpoints(current, 0);
  expect(result.checkpoints).toHaveLength(1);
  expect(result.checkpoints[0]).toMatchObject({
    index: 0, publicationId: committed.publicationId, manifestHash: committed.manifestHash,
    source: { workflowId: 'run', task: 'train', attempt: 1, epoch: 'epoch-1' },
    path: '/fsx/checkpoints/projects/p/runs/run/attempts/2/train',
    destination: `/fsx/checkpoints/projects/p/runs/run/attempts/2/train/.pai-resume/replica-0/checkpoint-0/${committed.manifestHash}`,
    files: [{ path: 'final/model.bin', size: 9, checksumSHA256: checksum('committed'), checksumType: 'FULL_OBJECT', versionId: 'object-1' }],
  });
  expect(manifestVersions.at(-1)).toBe(committed.manifestVersionId);
  expect(gets[0].version).toBe('object-1');
});

it('selects the newest committed snapshot and supports same-project server-recorded manual retry lineage', async () => {
  await commit('first'); now = new Date(now.getTime() + 1000);
  const latest = await commit('second');
  const current = await nextAttempt(true);
  const result = await broker.checkpoints(current, 0);
  expect(result.checkpoints[0].publicationId).toBe(latest.publicationId);
  expect(result.checkpoints[0].destination).toContain('/retry-run/attempts/1/train/.pai-resume/');
});

it('never restores PENDING data and reports an empty cold-start plan when no committed checkpoint exists', async () => {
  await broker.planUploads(token, request('unfinished'));
  expect((await broker.checkpoints(await nextAttempt(), 0)).checkpoints).toEqual([]);
  expect(gets).toEqual([]);
});

it('rejects a corrupt committed manifest instead of falling back to an older checkpoint or cold start', async () => {
  await commit('first'); now = new Date(now.getTime() + 1000);
  const latest = await commit('second');
  const key = new URL(latest.manifestUri).pathname.slice(1);
  manifests.set(key, { ...manifests.get(key)!, body: manifests.get(key)!.body + ' ' });
  await expect(broker.checkpoints(await nextAttempt(), 0)).rejects.toMatchObject({ status: 409 });
  expect(gets).toEqual([]);
});

it('rejects missing object versions, cross-project sources, unrelated same-project runs, and fencing during restore', async () => {
  await commit('committed');
  const current = await nextAttempt(true);
  const source = (await repo.getWorkflow('run'))!;
  await repo.putWorkflow({ ...source, projectId: 'other' });
  await expect(broker.checkpoints(current, 0)).rejects.toMatchObject({ status: 403 });
  await repo.putWorkflow(source);
  await repo.putWorkflow({ ...workflow, retryOf: undefined } as RecoveryWorkflow);
  await expect(broker.checkpoints(current, 0)).rejects.toMatchObject({ status: 403 });
  await repo.putWorkflow(workflow);
  const head = store.head;
  store.head = async (...args) => {
    const value = await head(...args);
    await repo.kv.put({ pk: 'WF#retry-run', sk: 'FENCE#epoch-new' });
    return value;
  };
  await expect(broker.checkpoints(current, 0)).rejects.toMatchObject({ status: 410 });
  expect(gets).toEqual([]);
});

it('adopts older READY publication metadata without restoring an uncommitted manifest', async () => {
  const committed = await commit('legacy');
  for (const row of await repo.kv.query('WF#run', 'RUNTIME#epoch-1#CHECKPOINT#')) await repo.kv.del(row.pk, row.sk);
  expect((await broker.checkpoints(await nextAttempt(), 0)).checkpoints[0].publicationId).toBe(committed.publicationId);
});

it('refuses a missing immutable object version even when the latest key has replacement bytes', async () => {
  await commit('old');
  const object = [...objects.entries()][0];
  objects.set(object[0], { ...object[1], versionId: 'replacement-version' });
  await expect(broker.checkpoints(await nextAttempt(), 0)).rejects.toThrow(/version missing/);
  expect(gets).toEqual([]);
});
