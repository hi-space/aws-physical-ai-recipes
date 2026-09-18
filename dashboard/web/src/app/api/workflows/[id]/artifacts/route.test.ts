import { beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createHash } from 'node:crypto';
const { send, sign } = vi.hoisted(() => ({ send: vi.fn(), sign: vi.fn(async (..._args: any[]) => 'https://download.invalid/pinned') }));
vi.mock('@/server/aws/clients', () => ({ s3: () => ({ send }) }));
vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: sign }));
import { Repo, setRepoForTests } from '@/server/store/repo';
import { MemoryKV } from '@/server/store/dynamo';
import { SESSION_HEADERS, type Session } from '@/server/auth/session';
import type { Workflow } from '@/server/store/types';
import { GET } from './route';
import { GET as download } from '../../../datasets/[name]/versions/[v]/download/route';

const alice: Session = { user: 'alice', subject: 'alice', role: 'viewer', email: '' };
const checksum = Buffer.alloc(32).toString('base64');
let repo: Repo;
const req = (session: Session, path: string) => new NextRequest('http://localhost' + path, { headers: {
  [SESSION_HEADERS.user]: session.user, [SESSION_HEADERS.subject]: session.subject!, [SESSION_HEADERS.role]: session.role, 'x-pai-project': 'p',
} });
const object = (path: string, bytes: number) => ({ path, key: `projects/p/runs/w/attempts/1/evaluate/h/${path}`, versionId: 'v-' + path, bytes, checksumSHA256: checksum, checksumType: 'FULL_OBJECT' });
const manifest = JSON.stringify({ schemaVersion: 1, identity: 'workflow:pub:1', source: { bucket: 'data', prefix: 'x/' }, objects: [
  object('evaluation.json', 1365), object('plots/traj_0.jpeg', 40_000), object('videos/episode-0000.mp4', 14_545), object('model.safetensors', 9_000_000_000),
] });

beforeEach(async () => {
  vi.stubEnv('DASHBOARD_ARTIFACT_BUCKET', 'archive');
  repo = new Repo(new MemoryKV()); setRepoForTests(repo);
  await repo.kv.put({ pk: 'PROJECT#p', sk: 'META', id: 'p', name: 'P', namespace: 'hyperpod-ns-p', queue: 'q', members: { alice: 'viewer' }, credentialRefs: [], createdAt: '', updatedAt: '' });
  await repo.putWorkflow({ id: 'w', projectId: 'p', name: 'eval', namespace: 'hyperpod-ns-p', owner: 'owner', status: 'SUCCEEDED', spec: {} as never, specYaml: '', vars: {},
    createdAt: '', updatedAt: '', taskCount: 2, succeededCount: 2, failedCount: 0 } satisfies Workflow);
  await repo.putTask({ workflowId: 'w', name: 'evaluate', phase: 'SUCCEEDED', attempts: 1, replicas: 1, updatedAt: '', outputPath: '/fsx/checkpoints/projects/p/runs/w/attempts/1/evaluate',
    publishedVersions: [{ dataset: 'eval', version: 1 }] });
  await repo.putTask({ workflowId: 'w', name: 'train', phase: 'SUCCEEDED', attempts: 1, replicas: 1, updatedAt: '', publishedVersions: [{ dataset: 'legacy', version: 2 }, { dataset: 'missing', version: 1 }] });
  await repo.putTask({ workflowId: 'w', name: 'prepare', phase: 'SUCCEEDED', attempts: 1, replicas: 1, updatedAt: '' });
  await repo.putDataset({ name: 'eval', projectId: 'p', owner: 'owner', tags: [], latestVersion: 1, createdAt: '', updatedAt: '' });
  await repo.putVersion({ dataset: 'eval', version: 1, projectId: 'p', uri: 's3://archive/projects/p/runs/w/attempts/1/evaluate/h/', manifestUri: 's3://archive/projects/p/runs/w/attempts/1/evaluate/h/manifest.json',
    manifestHash: createHash('sha256').update(manifest).digest('hex'), state: 'READY', createdAt: '', createdBy: 'owner', tags: [] });
  await repo.putDataset({ name: 'legacy', projectId: 'p', owner: 'owner', tags: [], latestVersion: 2, createdAt: '', updatedAt: '' });
  await repo.putVersion({ dataset: 'legacy', version: 2, projectId: 'p', uri: 's3://data/checkpoints/workflows/old/train', createdAt: '', createdBy: 'owner', tags: [] });
  send.mockReset().mockImplementation(async c => c.constructor.name === 'GetObjectCommand'
    ? { ContentLength: manifest.length, Body: { transformToString: async () => manifest } }
    : { VersionId: c.input.VersionId, ContentLength: JSON.parse(manifest).objects.find((o: { key: string }) => o.key === c.input.Key)?.bytes, ChecksumSHA256: checksum, ChecksumType: 'FULL_OBJECT' });
  sign.mockClear();
});

it('lists pinned files per task with preview kinds and explains legacy or missing versions instead of failing', async () => {
  const response = await GET(req(alice, '/api/workflows/w/artifacts'), { params: Promise.resolve({ id: 'w' }) });
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const data = await response.json();
  expect(data).toMatchObject({ workflowId: 'w', status: 'SUCCEEDED', mediaCount: 2, fileCount: 4 });
  expect(data.tasks.map((t: { task: string }) => t.task)).toEqual(['evaluate', 'train']);
  const ready = data.tasks[0].versions[0];
  expect(ready).toMatchObject({ dataset: 'eval', version: 1, state: 'ready', fileCount: 4, mediaCount: 2, truncated: false, sizeBytes: 9_000_055_910 });
  expect(ready.files).toEqual([
    { path: 'evaluation.json', bytes: 1365, kind: 'json', previewable: true },
    { path: 'model.safetensors', bytes: 9_000_000_000, kind: 'other', previewable: false },
    { path: 'plots/traj_0.jpeg', bytes: 40_000, kind: 'image', previewable: true },
    { path: 'videos/episode-0000.mp4', bytes: 14_545, kind: 'video', previewable: true },
  ]);
  const [legacy, missing] = data.tasks[1].versions;
  expect(legacy).toMatchObject({ dataset: 'legacy', version: 2, state: 'unavailable', files: [] });
  expect(legacy.message).toMatch(/구버전/);
  expect(missing).toMatchObject({ dataset: 'missing', state: 'unavailable' });
  expect(sign).not.toHaveBeenCalled();
});

it('denies workflows outside the caller projects and unknown workflows with 404', async () => {
  const other = { ...alice, user: 'bob', subject: 'bob' };
  expect((await GET(req(other, '/api/workflows/w/artifacts'), { params: Promise.resolve({ id: 'w' }) })).status).toBe(404);
  expect((await GET(req(alice, '/api/workflows/nope/artifacts'), { params: Promise.resolve({ id: 'nope' }) })).status).toBe(404);
});

it('presigns inline previews with a browser content type while downloads stay attachments', async () => {
  const params = { params: Promise.resolve({ name: 'eval', v: '1' }) };
  const inline = await download(req(alice, '/api/datasets/eval/versions/1/download?path=videos%2Fepisode-0000.mp4&inline=1'), params);
  expect(inline.status).toBe(200);
  expect(await inline.json()).toMatchObject({ kind: 'video', versionId: 'v-videos/episode-0000.mp4', size: 14_545 });
  expect(sign.mock.calls[0][1].input).toMatchObject({ VersionId: 'v-videos/episode-0000.mp4', ResponseContentType: 'video/mp4', ResponseContentDisposition: "inline; filename*=UTF-8''episode-0000.mp4" });
  const attachment = await download(req(alice, '/api/datasets/eval/versions/1/download?path=evaluation.json'), params);
  expect(attachment.status).toBe(200);
  expect(sign.mock.calls[1][1].input.ResponseContentDisposition).toMatch(/^attachment;/);
  expect(sign.mock.calls[1][1].input.ResponseContentType).toBeUndefined();
});
