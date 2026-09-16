import { beforeEach, describe, expect, it, vi } from 'vitest';
const { head, snapshot } = vi.hoisted(() => ({ head: vi.fn(), snapshot: vi.fn() }));
vi.mock('../aws/s3', () => ({
  parseS3Uri: (uri: string) => { const match = /^s3:\/\/([^/]+)\/(.*)$/.exec(uri)!; return { bucket: match[1], key: match[2] }; },
  assertBucket: vi.fn(), listAll: vi.fn(async () => [{ key: 'data.bin', size: 3 }]),
  presignPut: vi.fn(async () => 'https://upload.example.invalid'), headObject: head,
}));
vi.mock('../storage/snapshots', () => ({ snapshotPrefix: snapshot }));
import { createDataset, createVersion, uploadUrl, refreshSize, finalizePendingVersions, assertDatasetOwner } from './datasets';
import { MemoryKV } from '../store/dynamo';
import { Repo, setRepoForTests } from '../store/repo';
import type { Project } from '../auth/projects';
let repo: Repo;
const project: Project = { id: 'a', name: 'A', namespace: 'hyperpod-ns-a', queue: 'hyperpod-ns-a-localqueue', members: {}, credentialRefs: [], createdAt: '', updatedAt: '' };
beforeEach(async () => {
  vi.stubEnv('DASHBOARD_ARTIFACT_BUCKET', 'archive');
  repo = new Repo(new MemoryKV()); setRepoForTests(repo);
  head.mockReset().mockResolvedValue({ ContentLength: 3 });
  snapshot.mockReset().mockResolvedValue({
    hash: 'a'.repeat(64),
    manifest: { createdAt: '2026-09-16T00:00:00Z', objects: [{ path: 'file', bytes: 3, versionId: 'pinned', checksumSHA256: Buffer.alloc(32).toString('base64'), checksumType: 'FULL_OBJECT' }] },
  });
  await createDataset({ name: 'demo' }, 'alice', project, 'alice-sub');
});
describe('dataset publication', () => {
  it('reserves distinct pending versions for concurrent uploads', async () => {
    const versions = await Promise.all([createVersion('demo', {}, 'alice'), createVersion('demo', {}, 'alice')]);
    expect(versions.map((v) => v.version).sort()).toEqual([1, 2]);
    expect(versions.every((v) => v.state === 'PENDING')).toBe(true);
    expect(new Set(versions.map((v) => v.uri)).size).toBe(2);
  });
  it('commits verified versions asynchronously and disallows subsequent upload', async () => {
    const v = await createVersion('demo', {}, 'alice');
    await uploadUrl('demo', v.version, 'images/frame.png');
    await refreshSize('demo', v.version);
    expect((await repo.getVersion('demo', v.version))?.state).toBe('PENDING');
    await finalizePendingVersions();
    expect(await repo.getVersion('demo', v.version)).toMatchObject({ state: 'READY', manifestHash: 'a'.repeat(64), sizeBytes: 3, objectCount: 1 });
    await expect(uploadUrl('demo', v.version, 'changed.png')).rejects.toThrow(/immutable/);
    expect((await repo.getVersion('demo', v.version))?.uri).not.toBe(v.uri);
  });
  it('does not commit while an expected upload is missing', async () => {
    const v = await createVersion('demo', {}, 'alice');
    await uploadUrl('demo', v.version, 'missing.bin');
    await refreshSize('demo', v.version);
    head.mockRejectedValue(Object.assign(new Error('Expected upload is missing'), { name: 'NotFound' }));
    await finalizePendingVersions();
    expect((await repo.getVersion('demo', v.version))?.state).toBe('PENDING');
    expect(snapshot).not.toHaveBeenCalled();
  });
});

it('uses the immutable Cognito owner subject rather than a reused display username',async()=>{
 await expect(assertDatasetOwner({user:'alice',subject:'other-sub',role:'researcher',email:''},'demo')).rejects.toMatchObject({status:403});
 await expect(assertDatasetOwner({user:'renamed-alice',subject:'alice-sub',role:'researcher',email:''},'demo')).resolves.toBeUndefined();
});
it('retires permanently invalid finalization requests so later versions can publish',async()=>{
 const {badRequest}=await import('../errors');
 for(let i=0;i<11;i++){const version=await createVersion('demo',{},'alice');await refreshSize('demo',version.version);}
 snapshot.mockRejectedValue(badRequest('Runtime input exceeds supported file count'));
 await finalizePendingVersions();
 expect(await repo.kv.queryGsi1('TYPE#DATASET_FINALIZATION')).toHaveLength(1);
 snapshot.mockResolvedValue({hash:'a'.repeat(64),manifestVersionId:'manifest-v',manifest:{createdAt:'2026-09-16T00:00:00Z',objects:[{path:'file',bytes:3,versionId:'pinned',checksumSHA256:Buffer.alloc(32).toString('base64'),checksumType:'FULL_OBJECT'}]}});
 await finalizePendingVersions();
 expect(await repo.kv.queryGsi1('TYPE#DATASET_FINALIZATION')).toHaveLength(0);
 expect((await repo.listVersions('demo')).filter(v=>v.state==='READY')).toHaveLength(1);
 expect((await repo.listVersions('demo')).filter(v=>v.finalizationError)).toHaveLength(10);
});
