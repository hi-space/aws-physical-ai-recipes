import { beforeEach, expect, it, vi } from 'vitest';
import { Repo } from '../store/repo';
import { MemoryKV } from '../store/dynamo';
import type { Project } from '../auth/projects';
import { projectItem } from '../auth/projects';
import { projectFixture, testSession } from '../auth/session.test-helpers';
import { sourceBuildService, reconcileSourceBuilds } from './source-builds';
import { parseBuildTargets, SourceBuildProviderError, type SourceBuildDeps, type BuildObservation } from './source-builds-contract';

const sha = 'a'.repeat(40), accountId = '123456789012';
const project: Project = projectFixture('a');
// `admin` here is a project-admin (proj-a-admin), not a platform admin.
const admin = testSession('admin', 'admin', 'researcher', ['proj-a-admin']);
const user = testSession('user', 'user', 'researcher', ['proj-a']);
const viewer = testSession('viewer', 'viewer', 'viewer', ['proj-a']);
const target = parseBuildTargets(JSON.stringify([{ id: 'a-build', projectId: 'a', codeBuildProjectName: 'pai-source-a',
  sourceType: 'GITHUB', repositoryUrl: 'https://github.com/example/source', builderImage: `${accountId}.dkr.ecr.us-east-1.amazonaws.com/builder@sha256:${'b'.repeat(64)}`,
  serviceRoleArn: `arn:aws:iam::${accountId}:role/source-a`, outputRepositoryName: 'physical-ai/projects/a/images' }]), accountId, 'us-east-1', [])[0];
let d: SourceBuildDeps, now: number, seq: number, observed: BuildObservation;
const signal = () => new AbortController().signal;
const tick = async () => { now += 6000; await reconcileSourceBuilds(signal(), d); };
beforeEach(async () => {
  now = Date.parse('2026-09-16T12:00:00Z'); seq = 0;
  const repo = new Repo(new MemoryKV()); await repo.kv.put(projectItem(project));
  observed = { id: 'pai-source-a:12345678-1234-1234-1234-123456789abc',
    arn: `arn:aws:codebuild:us-east-1:${accountId}:build/pai-source-a:12345678-1234-1234-1234-123456789abc`,
    status: 'IN_PROGRESS', phase: 'BUILD', sourceVersion: sha, resolvedSourceVersion: sha, configurationMatches: true,
    archiveSha256: 'c'.repeat(64), dockerfileSha256: 'd'.repeat(64), startedAt: new Date(now).toISOString() };
  d = { repo, now: () => now, randomId: () => String(++seq), targets: () => [target], provider: {
    checkTarget: vi.fn(async () => ({ configurationHash: 'c'.repeat(64) })),
    start: vi.fn(async () => observed.id), read: vi.fn(async () => ({ ...observed })), find: vi.fn(async () => undefined),
    stop: vi.fn(async () => {}), logs: vi.fn(async () => ({ lines: [], truncated: false })),
    inspectOutput: vi.fn(async () => ({ accountId, region: 'us-east-1', repository: target.outputRepositoryName,
      requestedImage: 'image', resolvedImage: `${accountId}.dkr.ecr.us-east-1.amazonaws.com/${target.outputRepositoryName}@sha256:${'e'.repeat(64)}`,
      digest: `sha256:${'e'.repeat(64)}`, architectures: ['amd64' as const], manifests: [], inspectedAt: new Date(now).toISOString(), source: 'ecr-manifest-config' as const })),
  } };
});
const registration = () => sourceBuildService(admin, d).register({ targetId: target.id, name: 'Source' }, project, signal());
const start = async (key = 'request-key-0001') => {
  const source = await registration();
  return sourceBuildService(user, d).start({ sourceId: source.id, commit: sha }, project, key, signal());
};
it('requires fresh project administration for registration and project researcher role for execution', async () => {
  await expect(sourceBuildService(user, d).register({ targetId: target.id, name: 'x' }, project, signal())).rejects.toMatchObject({ status: 403 });
  const source = await registration();
  await expect(sourceBuildService(viewer, d).start({ sourceId: source.id, commit: sha }, project, 'request-key-0001', signal())).rejects.toMatchObject({ status: 403 });
  await expect(sourceBuildService({ ...user, tokenProjectId: 'b' }, d).start({ sourceId: source.id, commit: sha }, project, 'request-key-0001', signal())).rejects.toMatchObject({ status: 403 });
  // Membership now lives on the caller's own session groups (resolveProject reads them directly, not a
  // persisted project.members map), so a dedicated, mutable session simulates mid-call revocation.
  const revocable = testSession('user', 'user', 'researcher', ['proj-a']);
  d.provider.checkTarget = async () => {
    revocable.groups = [];
    return { configurationHash: 'c'.repeat(64) };
  };
  await expect(sourceBuildService(revocable, d).start({ sourceId: source.id, commit: sha }, project, 'request-key-0001', signal())).rejects.toMatchObject({ status: 403 });
  expect(d.provider.start).not.toHaveBeenCalled();
});
it('durably deduplicates intent and rejects reuse of a request key with different source', async () => {
  const first = await start();
  expect((await start()).id).toBe(first.id);
  const source = await registration();
  await expect(sourceBuildService(user, d).start({ sourceId: source.id, commit: 'b'.repeat(40) }, project, 'request-key-0001', signal())).rejects.toMatchObject({ status: 409 });
  await Promise.all([tick(), tick()]);
  expect(d.provider.start).toHaveBeenCalledTimes(1);
});
it('publishes immutable source and ECR provenance only after actual build and image verification', async () => {
  const run = await start(); await tick();
  observed.status = 'SUCCEEDED'; observed.finishedAt = new Date(now).toISOString(); await tick();
  const result = await sourceBuildService(viewer, d).get(run.id, project);
  expect(result.state).toBe('SUCCEEDED');
  expect(result.provenance).toMatchObject({ commit: sha, resolvedCommit: sha, sourceArchiveSha256: 'c'.repeat(64),
    output: { digest: `sha256:${'e'.repeat(64)}` }, runtimeValidation: 'not-performed' });
  expect(await sourceBuildService(user, d).provenance(run.id, result.provenance!.output.resolvedImage, project)).toEqual(result.provenance);
  await expect(sourceBuildService(user, d).provenance(run.id, 'different-image', project)).rejects.toMatchObject({ status: 409 });
  const before = JSON.stringify(result.provenance);
  observed.resolvedSourceVersion = 'f'.repeat(40); await tick();
  expect(JSON.stringify((await sourceBuildService(viewer, d).get(run.id, project)).provenance)).toBe(before);
});
it('does not equate CodeBuild SUCCEEDED with a valid source or a published image', async () => {
  const run = await start(); await tick(); observed.status = 'SUCCEEDED'; observed.resolvedSourceVersion = 'f'.repeat(40); await tick();
  expect((await sourceBuildService(viewer, d).get(run.id, project)).state).toBe('FAILED');
  expect(d.provider.inspectOutput).not.toHaveBeenCalled();
});
it('keeps missing output in VERIFYING then fails explicitly without false provenance', async () => {
  const run = await start(); await tick(); observed.status = 'SUCCEEDED';
  d.provider.inspectOutput = async () => { throw new SourceBuildProviderError('build_output_not_published'); };
  await tick(); expect((await sourceBuildService(viewer, d).get(run.id, project)).state).toBe('VERIFYING');
  now += 180000; await tick();
  const result = await sourceBuildService(viewer, d).get(run.id, project);
  expect(result.state).toBe('FAILED'); expect(result.provenance).toBeUndefined();
});
it('adopts a build after a lost StartBuild reply without starting another', async () => {
  d.provider.start = vi.fn(async () => { throw new SourceBuildProviderError('build_start_unavailable'); });
  const run = await start(); await tick();
  d.provider.find = async () => ({ ...observed });
  await tick();
  expect((await sourceBuildService(viewer, d).get(run.id, project)).buildId).toBe(observed.id);
  expect(d.provider.start).toHaveBeenCalledTimes(1);
});
it('never repeats an unresolved start after the short provider idempotency window', async () => {
  d.provider.start = vi.fn(async () => { throw new SourceBuildProviderError('build_start_unavailable'); });
  const run = await start(); await tick(); now += 300000; await tick();
  expect(d.provider.start).toHaveBeenCalledTimes(1);
  expect((await sourceBuildService(viewer, d).get(run.id, project)).state).toBe('START_UNCERTAIN');
});
it('bounds project execution slots and releases them only after confirmed terminal state', async () => {
  const results = await Promise.allSettled([start('request-key-0001'), start('request-key-0002'), start('request-key-0003')]);
  expect(results.filter(value => value.status === 'fulfilled')).toHaveLength(2);
  expect(results.find(value => value.status === 'rejected')).toMatchObject({ reason: { status: 429 } });
  await tick(); observed.status = 'FAILED'; await tick();
  expect((await start('request-key-0003')).state).toBe('STARTING');
});
it('a cancellation before dispatch does not start cloud work and cannot target another project', async () => {
  const run = await start();
  await sourceBuildService(user, d).cancel(run.id, project);
  await tick();
  expect((await sourceBuildService(user, d).get(run.id, project)).state).toBe('CANCELLED');
  expect(d.provider.start).not.toHaveBeenCalled();
  await d.repo.kv.put({ pk: 'PROJECT#b', sk: 'META', ...project, id: 'b' });
  // Member of both projects, so this specifically exercises "not found under project b" rather than
  // a plain membership 403 for project b.
  const userOfBoth = testSession('user', 'user', 'researcher', ['proj-a', 'proj-b']);
  await expect(sourceBuildService(userOfBoth, d).get(run.id, { ...project, id: 'b' })).rejects.toMatchObject({ status: 404 });
});
it('S3 provenance pins its source version/hash and never invents a Git commit or pinned managed builder', async () => {
  const snapshot = { bucket: 'source-bucket', key: 'source.zip', versionId: 'version-one', sha256: 'c'.repeat(64), bytes: 100 };
  const s3 = { ...target, repositoryUrl: undefined, sourceType: 'S3' as const, snapshotLocation: { bucket: snapshot.bucket, key: snapshot.key }, builderImage: 'aws/codebuild/standard:7.0' };
  d.targets = () => [s3]; d.provider.checkTarget = vi.fn(async () => ({ configurationHash: 'c'.repeat(64), snapshot }));
  const source = await registration();
  const run = await sourceBuildService(user, d).start({ sourceId: source.id }, project, 'request-snapshot-one', signal());
  await tick(); observed.status = 'SUCCEEDED'; observed.sourceVersion = snapshot.versionId; observed.resolvedSourceVersion = undefined;
  await tick();
  const result = await sourceBuildService(viewer, d).get(run.id, project);
  expect(result.state).toBe('SUCCEEDED');
  expect(result.provenance).toMatchObject({ sourceType: 'S3', snapshot, builderImagePinned: false, sourceArchiveSha256: snapshot.sha256 });
  expect(result.provenance?.commit).toBeUndefined();
  expect(result.provenance?.resolvedCommit).toBeUndefined();
});
const snapshotFixture = { bucket: 'source-bucket', key: 'source.zip', versionId: 'version-one', bytes: 100, sha256: 'c'.repeat(64) };
function useSnapshotFixture() {
  d.targets = () => [{ ...target, repositoryUrl: undefined, sourceType: 'S3', snapshotLocation: {
    bucket: snapshotFixture.bucket, key: snapshotFixture.key,
  } }];
  d.provider.checkTarget = vi.fn(async () => ({ configurationHash: 'c'.repeat(64), snapshot: { ...snapshotFixture } }));
}
function reorderStoredMaps() {
  const get = d.repo.kv.get.bind(d.repo.kv);
  vi.spyOn(d.repo.kv, 'get').mockImplementation(async (...args) => {
    const row = await get(...args);
    return row && JSON.parse(JSON.stringify(row), (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
  });
}
it.each(['request', 'worker'])('accepts unchanged S3 source after persisted maps reorder before %s verification', async boundary => {
  useSnapshotFixture();
  const source = await registration();
  if (boundary === 'request') reorderStoredMaps();
  const run = await sourceBuildService(user, d).start({ sourceId: source.id }, project, 'snapshot-map-order', signal());
  if (boundary === 'worker') reorderStoredMaps();
  await tick();
  expect((await sourceBuildService(user, d).get(run.id, project)).state).toBe('RUNNING');
  expect(d.provider.start).toHaveBeenCalledTimes(1);
  expect(d.provider.start).toHaveBeenCalledWith(expect.objectContaining({ snapshot: snapshotFixture }), expect.any(AbortSignal));
  const saved = await d.repo.kv.get('PROJECT#a', `SOURCE#${source.id}`);
  expect(saved).toMatchObject({ id: source.id, configurationHash: source.configurationHash, contentHash: source.contentHash });
});
it.each([
  ['bucket', 'another-bucket'], ['key', 'another.zip'], ['versionId', 'another-version'],
  ['sha256', 'd'.repeat(64)], ['bytes', 101],
] as const)('still rejects an actual S3 %s change before request or worker dispatch', async (field, value) => {
  useSnapshotFixture();
  const source = await registration();
  const run = await sourceBuildService(user, d).start({ sourceId: source.id }, project, 'accepted-before-change', signal());
  d.provider.checkTarget = vi.fn(async () => ({ configurationHash: source.configurationHash, snapshot: { ...snapshotFixture, [field]: value } }));
  await expect(sourceBuildService(user, d).start({ sourceId: source.id }, project, 'rejected-after-change', signal())).rejects.toMatchObject({ status: 409 });
  await tick();
  expect((await sourceBuildService(user, d).get(run.id, project)).state).toBe('FAILED');
  expect(d.provider.start).not.toHaveBeenCalled();
});
it('a later definitive retry error does not release an ambiguous earlier start as though no build exists', async () => {
  d.provider.start = vi.fn(async () => { throw new SourceBuildProviderError('start_reply_lost'); });
  const run = await start(); await tick();
  d.provider.start = vi.fn(async () => { throw new SourceBuildProviderError('parameter_mismatch', true); });
  await tick();
  expect((await sourceBuildService(viewer, d).get(run.id, project)).state).toBe('START_UNCERTAIN');
  await start('request-key-0002');
  await expect(start('request-key-0003')).rejects.toMatchObject({ status: 429 });
});
it('does not report cancellation or release its slot until the owned remote build is terminal', async () => {
  const run = await start(); await tick(); await sourceBuildService(user, d).cancel(run.id, project); await tick();
  expect((await sourceBuildService(viewer, d).get(run.id, project)).state).toBe('CANCELLING');
  expect(d.provider.stop).toHaveBeenCalledTimes(1);
  observed.status = 'STOPPED'; await tick();
  expect((await sourceBuildService(viewer, d).get(run.id, project)).state).toBe('CANCELLED');
});
it('lets a project administrator recover an unresolved ID only after provider identity verification', async () => {
  d.provider.start = vi.fn(async () => { throw new SourceBuildProviderError('start_reply_lost'); });
  const run = await start(); await tick(); now += 300000; await tick();
  await expect(sourceBuildService(user, d).recover(run.id, observed.id, project, signal())).rejects.toMatchObject({ status: 403 });
  d.provider.read = async () => { throw new SourceBuildProviderError('build_identity_mismatch', true); };
  await expect(sourceBuildService(admin, d).recover(run.id, observed.id, project, signal())).rejects.toThrow();
  expect((await sourceBuildService(viewer, d).get(run.id, project)).buildId).toBeUndefined();
  d.provider.read = async () => ({ ...observed });
  await sourceBuildService(admin, d).recover(run.id, observed.id, project, signal());
  expect((await sourceBuildService(viewer, d).get(run.id, project)).buildId).toBe(observed.id);
  expect(d.provider.start).toHaveBeenCalledTimes(1);
});
it('expires an undispatched intent even if a later deployment breaks the target configuration', async () => {
  const run = await start(); now += 301000;
  d.targets = () => { throw new Error('invalid deployment target config'); };
  await tick();
  expect((await sourceBuildService(viewer, d).get(run.id, project)).state).toBe('FAILED');
  expect(d.provider.start).not.toHaveBeenCalled();
});
