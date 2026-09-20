import { MemoryKV } from '../store/dynamo';
import { Repo } from '../store/repo';
import { workflowSchema } from '../workflow/schema';
import type { Session } from '../auth/session';
import { putProject, testSession } from '../auth/session.test-helpers';
import type { DatasetVersion, Task, Workflow } from '../store/types';
import { digest, type ObjectMetadata, type ObjectReference, type ObjectStorage } from './evidence';
import { createHash } from 'node:crypto';

export const alice: Session = testSession('alice', 'alice-sub', 'researcher', ['proj-a-admin']);
export const bob: Session = testSession('bob', 'bob-sub', 'researcher', ['proj-b']);
export const reader: Session = testSession('reader', 'reader-sub', 'viewer', ['proj-a']);
export const admin: Session = testSession('admin', 'admin-sub', 'admin');
export const now = '2026-09-16T00:00:00.000Z';
const checksum = (body: Uint8Array) => createHash('sha256').update(body).digest('base64');

export class FakeObjects implements ObjectStorage {
  files = new Map<string, { metadata: ObjectMetadata; body: Uint8Array }>();
  latest = new Map<string, string>();
  reads: ObjectReference[] = [];
  heads: ObjectReference[] = [];
  add(key: string, value: unknown, versionId = 'object-v1') {
    const body = value instanceof Uint8Array ? Buffer.from(value) : typeof value === 'string' ? Buffer.from(value) : Buffer.from(JSON.stringify(value));
    const metadata = { versionId, bytes: body.byteLength, checksumSHA256: checksum(body), checksumType: 'FULL_OBJECT' };
    this.files.set(`archive/${key}/${versionId}`, { metadata, body });
    this.latest.set(`archive/${key}`, versionId);
    return { key, versionId, bytes: body.byteLength, checksumSHA256: metadata.checksumSHA256, checksumType: 'FULL_OBJECT' };
  }
  find(ref: ObjectReference) {
    const version = ref.versionId ?? this.latest.get(`${ref.bucket}/${ref.key}`);
    const file = this.files.get(`${ref.bucket}/${ref.key}/${version}`);
    if (!file) throw new Error(`Missing fake object ${ref.key}@${version}`);
    return file;
  }
  async head(ref: ObjectReference) { this.heads.push({ ...ref }); return { ...this.find(ref).metadata }; }
  async get(ref: ObjectReference & { versionId: string }, limit: number) {
    this.reads.push({ ...ref });
    const file = this.find(ref);
    if (file.body.byteLength > limit) throw new Error('size limit');
    return { metadata: { ...file.metadata }, body: file.body };
  }
  async presign(ref: ObjectReference & { versionId: string }) {
    return `https://objects.example.invalid/${ref.key}?versionId=${encodeURIComponent(ref.versionId)}`;
  }
}
export async function fixture(options: { episodes?: number; successes?: number; latency?: number | null; composite?: boolean } = {}) {
  const repo = new Repo(new MemoryKV());
  const objects = new FakeObjects();
  for (const id of ['a', 'b']) await putProject(repo.kv, id, { createdAt: now, updatedAt: now });
  const modelBody = 'actual-test-checkpoint-bytes';
  const statsBody = 'matching-test-vecnormalize-bytes';
  const simulator = { name: 'MuJoCo', version: '3.3.2', sceneSha256: 'c'.repeat(64) };
  const training = workflowSchema.parse({ workflow: { name: 'train-run', resources: { cpu: { cpu: 1 } },
    tasks: [{ name: 'train', image: 'verified/mujoco@sha256:' + 'e'.repeat(64), resource: 'cpu',
      command: ['python', '/opt/recipes/mujoco/train.py'], outputs: [{ dataset: { name: 'weights-run', path: '{{output}}' } }] }] } });
  const wf: Workflow = { id: 'train-run', projectId: 'a', ownerSubject: 'alice-sub', owner: 'alice',
    name: 'train-run', namespace: 'hyperpod-ns-a', status: 'SUCCEEDED', spec: training, specYaml: '',
    specHash: 'f'.repeat(64), vars: {}, createdAt: now, updatedAt: now, taskCount: 1, succeededCount: 1, failedCount: 0,
    datasetSnapshots: { train: { 0: { name: 'demonstrations', version: 3, uri: 's3://archive/projects/a/datasets/demo/v3/',
      manifestHash: 'd'.repeat(64), fsxPath: '/fsx/datasets/projects/a/demo/v3' } } } };
  await repo.putWorkflow(wf);

  async function publish(dataset: string, run: string, task: string, files: Record<string, unknown>, projectId = 'a') {
    const publicationId = `pub-${dataset}`;
    const prefix = `projects/${projectId}/runs/${run}/attempts/1/${task}/${publicationId}/`;
    const entries = Object.entries(files).map(([path, value]) => ({ path, ...objects.add(prefix + path, value) }));
    if (options.composite && dataset === 'weights-run') {
      const entry = entries.find(e => e.path === 'final/model.zip')!;
      entry.checksumSHA256 += '-2'; entry.checksumType = 'COMPOSITE';
      const stored = objects.find({ bucket: 'archive', key: entry.key, versionId: entry.versionId });
      stored.metadata.checksumSHA256 = entry.checksumSHA256;
      stored.metadata.checksumType = entry.checksumType;
    }
    const manifest = { schemaVersion: 1, identity: `workflow:${publicationId}:1`, createdAt: now,
      source: { bucket: 'source', prefix: 'untrusted-source-not-read/' }, objects: entries };
    const manifestObject = objects.add(prefix + 'manifest.json', manifest, 'manifest-v1');
    const v: DatasetVersion = {
      projectId, ownerSubject: 'alice-sub', dataset, version: 1, state: 'READY',
      uri: `s3://archive/${prefix}`, manifestUri: `s3://archive/${prefix}manifest.json`,
      manifestHash: digest(objects.find({ bucket: 'archive', key: manifestObject.key, versionId: 'manifest-v1' }).body),
      producedBy: { workflowId: run, task }, producedAttempt: 1, publicationId, tags: [], createdAt: now, createdBy: 'alice',
      objectCount: entries.length, sizeBytes: entries.reduce((n, e) => n + e.bytes, 0), verifiedAt: now,
    };
    await repo.putDataset({ projectId, ownerSubject: 'alice-sub', owner: 'alice', name: dataset, tags: [], latestVersion: 1, createdAt: now, updatedAt: now });
    await repo.putVersion(v);
    const taskRecord: Task = { workflowId: run, name: task, phase: 'SUCCEEDED', attempts: 1, replicas: 1, updatedAt: now,
      outputPath: `/fsx/checkpoints/projects/${projectId}/runs/${run}/attempts/1/${task}`,
      publishedVersions: [{ dataset, version: 1 }], artifactReceipts: { [publicationId]: {
        uri: v.uri, manifestUri: v.manifestUri!, manifestHash: v.manifestHash!, verifiedAt: now, objectCount: entries.length, sizeBytes: v.sizeBytes!,
      } } };
    await repo.putTask(taskRecord);
    return v;
  }
  const source = await publish('weights-run', 'train-run', 'train', {
    'final/model.zip': modelBody, 'final/vecnormalize.pkl': statsBody,
    'final/manifest.json': { schemaVersion: 1, algorithm: 'PPO', task: 'Workshop-SO101-Reach-MuJoCo-v0', seed: 42,
      sha256: { 'model.zip': digest(modelBody), 'vecnormalize.pkl': digest(statsBody) }, simulator },
  });
  const n = options.episodes ?? 20;
  const successes = options.successes ?? n;
  const report = {
    schemaVersion: 1, type: 'closed_loop', task: 'Workshop-SO101-Reach-MuJoCo-v0', seed: 2042,
    episodeCount: n, successCount: successes, successRate: successes / n, timeoutCount: n, timeoutSeconds: 10,
    ...(options.latency !== null ? { latencyMs: { p95: options.latency ?? 5 } } : {}),
    checkpointDigest: digest(modelBody), normalizationDigest: digest(statsBody), simulator,
    videoUri: 'videos/episode-0000.mp4',
    episodes: Array.from({ length: n }, (_, index) => ({ index, seed: 2042 + index, steps: 200,
      success: index < successes, timeout: true, return: 0.5, finalDistance: 0.02,
      videoUri: `videos/episode-${String(index).padStart(4, '0')}.mp4` })),
  };
  const evalSpec = workflowSchema.parse({ workflow: { name: 'eval-run', resources: { cpu: { cpu: 1 } },
    tasks: [{ name: 'evaluate', resource: 'cpu', image: 'verified/mujoco@sha256:' + 'e'.repeat(64),
      command: ['python', '/opt/recipes/mujoco/evaluate.py'],
      inputs: [{ dataset: { name: source.dataset, version: 1 } }],
      outputs: [{ dataset: { name: 'evaluation-run', path: '{{output}}' } }] }] } });
  await repo.putWorkflow({ ...wf, id: 'eval-run', name: 'eval-run', spec: evalSpec, templateId: 'mujoco-render',
    datasetSnapshots: { evaluate: { 0: { name: source.dataset, version: 1, uri: source.uri,
      manifestHash: source.manifestHash, fsxPath: '/fsx/datasets/projects/a/weights-run/v1' } } } });
  const evaluation = await publish('evaluation-run', 'eval-run', 'evaluate', {
    'evaluation.json': report, ...Object.fromEntries(report.episodes.map(e => [e.videoUri, 'test-video-payload'])),
  });
  return { repo, objects, source, evaluation, report, publish, modelDigest: digest(modelBody), statsDigest: digest(statsBody) };
}
