import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Repo } from '../store/repo';
import { MemoryKV } from '../store/dynamo';
import type { Project } from '../auth/projects';
import { workflowSchema } from '../workflow/schema';
import { imageProfilesService, type ImageProfileDeps } from './image-profiles';

const uri = '123456789012.dkr.ecr.us-east-1.amazonaws.com/recipes/train:stable';
const digest = 'sha256:' + 'a'.repeat(64);
const resolved = uri.replace(':stable', '@' + digest);
const admin = { user: 'admin', subject: 'admin-sub', email: '', role: 'admin' as const };
const researcher = { user: 'alice', subject: 'alice-sub', email: '', role: 'researcher' as const };
const project: Project = { id: 'a', name: 'A', namespace: 'hyperpod-ns-a', queue: 'q-a', members: { 'alice-sub': 'researcher' }, credentialRefs: [], createdAt: 'x', updatedAt: 'x' };
let d: ImageProfileDeps;
const input = () => ({ id: 'training', name: 'Training image', image: uri, requirements: { minCpu: 2, minMemoryMiB: 4096, minGpu: 1, minGpuMemoryMiB: 16384, platforms: ['g5.8xlarge'] } });
const spec = (resources: Record<string, unknown> = {}, image = uri) => workflowSchema.parse({ workflow: {
  name: 'preflight', resources: { compute: { cpu: 4, memory: '8Gi', gpu: 1, platform: 'ml.g5.8xlarge', ...resources } },
  tasks: [{ name: 'train', resource: 'compute', image, command: ['python', 'train.py'] }],
} });
beforeEach(async () => {
  const repo = new Repo(new MemoryKV());
  await repo.kv.put({ pk: 'PROJECT#a', sk: 'META', gsi1pk: 'TYPE#PROJECT', gsi1sk: 'a', ...project });
  d = {
    repo, scope: { accountId: '123456789012', region: 'us-east-1' }, now: () => new Date('2026-09-16T12:00:00Z'),
    inspectImage: vi.fn<ImageProfileDeps['inspectImage']>(async () => ({ requestedImage: uri, resolvedImage: resolved, digest, repository: 'recipes/train', accountId: '123456789012', region: 'us-east-1',
      architectures: ['amd64'], manifests: [{ digest, configDigest: 'sha256:' + 'b'.repeat(64), architecture: 'amd64', os: 'linux' }],
      inspectedAt: '2026-09-16T12:00:00Z', source: 'ecr-manifest-config' })),
    hardware: vi.fn<ImageProfileDeps['hardware']>(async () => ({ source: 'eks-nodes+ec2-instance-types', checkedAt: '2026-09-16T12:00:00Z', catalogAvailable: true, nodes: [{
      name: 'gpu-a', instanceType: 'g5.8xlarge', architecture: 'amd64', ready: true, schedulable: true,
      allocatable: { cpu: 31.5, memoryMiB: 120 * 1024, gpu: 1 },
      catalog: { cpu: 32, memoryMiB: 128 * 1024, architectures: ['amd64'], gpuCount: 1, gpuMemoryMiB: 24 * 1024, gpuNames: ['A10G'] },
    }] })),
    environment: {},
  };
});

describe('immutable, project-owned image approval', () => {
  it('links only completed, same-project source provenance for the inspected digest into the immutable profile', async () => {
    const id = `sb-${'1'.repeat(32)}`, image = await d.inspectImage(uri);
    const provenance = { schemaVersion: 1, projectId: project.id, registrationId: `src-${'2'.repeat(32)}`,
      registrationHash: '3'.repeat(64), sourceType: 'S3', snapshot: { bucket: 'assets', key: 'source.zip', versionId: 'source-v1', sha256: '4'.repeat(64), bytes: 3 },
      sourceArchiveSha256: '4'.repeat(64), dockerfileSha256: '5'.repeat(64), buildId: 'job:00000000-0000-0000-0000-000000000001',
      buildArn: 'arn:aws:codebuild:us-east-1:123456789012:build/job:00000000-0000-0000-0000-000000000001',
      buildspecSha256: '6'.repeat(64), builderImage: 'aws/codebuild/standard:7.0', configurationHash: '7'.repeat(64),
      verifiedAt: d.now().toISOString(), output: image, builderImagePinned: false, dependencyResolution: 'not-attested', runtimeValidation: 'not-performed' };
    const row = { pk: `SOURCE_BUILD#${id}`, sk: 'META', id, projectId: project.id, state: 'SUCCEEDED', provenance };
    await d.repo.kv.put(row);
    const service = imageProfilesService(admin, d);
    const profile = await service.approve({ ...input(), sourceBuildId: id }, project);
    expect(profile.sourceBuild).toEqual({ id, provenance });
    expect((await service.get(profile.id, project, profile.version)).sourceBuild).toEqual(profile.sourceBuild);
    await d.repo.kv.put({ ...row, state: 'RUNNING' });
    await expect(service.approve({ ...input(), sourceBuildId: id, expectedVersion: 1 }, project)).rejects.toMatchObject({ status: 409 });
    await d.repo.kv.put({ ...row, projectId: 'other' });
    await expect(service.approve({ ...input(), sourceBuildId: id, expectedVersion: 1 }, project)).rejects.toMatchObject({ status: 404 });
  });
  it('retains immutable revisions and deduplicates identical approvals', async () => {
    const service = imageProfilesService(admin, d);
    const first = await service.approve(input(), project);
    expect(first).toMatchObject({ version: 1, approved: true, approvedBy: 'admin-sub', image: { resolvedImage: resolved } });
    expect((await service.approve({ ...input(), expectedVersion: 1 }, project)).version).toBe(1);
    const second = await service.approve({ ...input(), name: 'Revised requirements', expectedVersion: 1 }, project);
    expect(second.version).toBe(2);
    expect((await service.get('training', project, 1)).name).toBe('Training image');
    await expect(service.approve({ ...input(), expectedVersion: 1 }, project)).rejects.toMatchObject({ status: 409 });
  });
  it('requires admin approval and fresh project membership before reads and after probes', async () => {
    await expect(imageProfilesService(researcher, d).approve(input(), project)).rejects.toMatchObject({ status: 403 });
    await imageProfilesService(admin, d).approve(input(), project);
    await d.repo.kv.put({ pk: 'PROJECT#a', sk: 'META', ...project, members: {} });
    await expect(imageProfilesService(researcher, d).list(project)).rejects.toMatchObject({ status: 403 });
    expect(d.inspectImage).toHaveBeenCalledTimes(1);
  });
  it('rejects token project substitution even when the user belongs to both projects', async () => {
    await d.repo.kv.put({ pk: 'PROJECT#b', sk: 'META', ...project, id: 'b' });
    await expect(imageProfilesService({ ...researcher, tokenProjectId: 'a', authMethod: 'token' }, d).list({ ...project, id: 'b' })).rejects.toMatchObject({ status: 403 });
  });
  it('seeds only inspected candidates and does not overwrite an existing admin approval', async () => {
    d.environment = { MUJOCO_IMAGE_URI: uri, ROS2_IMAGE_URI: 'public.ecr.aws/unapproved:tag' };
    const service = imageProfilesService(admin, d);
    const result = await service.seed(project);
    expect(result.profiles).toHaveLength(1);
    expect(result.profiles[0]).toMatchObject({ approved: false, source: 'deployment-env', image: { digest } });
    expect(result.findings.some(f => f.code === 'image_mirror_required')).toBe(true);
    expect((await imageProfilesService(researcher, d).preflight(spec(), project)).status).toBe('blocked');
    await service.approve({ ...input(), id: 'builtin-mujoco', expectedVersion: 1 }, project);
    await service.seed(project);
    expect((await service.get('builtin-mujoco', project)).approved).toBe(true);
  });
});

describe('read-only preflight', () => {
  it('returns digest pins and catalog-based compatible capacity while driver/model access stay unknown', async () => {
    await imageProfilesService(admin, d).approve(input(), project);
    const before = JSON.stringify([...((d.repo.kv as MemoryKV).items)]);
    const workflow = spec(), original = JSON.stringify(workflow);
    const result = await imageProfilesService(researcher, d).preflight(workflow, project);
    expect(result.resolvedImageDigests).toEqual({ train: resolved });
    expect(result.tasks[0]).toMatchObject({ hardwareCompatibility: 'compatible', compatibleNodes: ['gpu-a'], driver: 'unknown', modelAccess: 'unknown', profileVersion: 1 });
    expect(result.status).toBe('needs-review');
    expect(JSON.stringify(workflow)).toBe(original);
    expect(JSON.stringify([...((d.repo.kv as MemoryKV).items)])).toBe(before);
  });
  it('blocks tag drift rather than silently approving the replacement image', async () => {
    await imageProfilesService(admin, d).approve(input(), project);
    const old = await d.inspectImage(uri);
    d.inspectImage = async () => ({ ...old, digest: 'sha256:' + 'c'.repeat(64), resolvedImage: uri.replace(':stable', '@sha256:' + 'c'.repeat(64)) });
    const result = await imageProfilesService(researcher, d).preflight(spec(), project);
    expect(result.status).toBe('blocked');
    expect(result.findings.some(f => f.code === 'image_digest_changed')).toBe(true);
    expect(result.resolvedImageDigests).toEqual({});
  });
  it.each([
    { resource: { gpu: 0 }, code: 'profile_requirements' },
    { resource: { memory: '2Gi' }, code: 'profile_requirements' },
    { resource: { cpu: '500m' }, code: 'profile_requirements' },
    { resource: { platform: 'ml.c5.4xlarge' }, code: 'profile_platform' },
  ])('rejects incompatible task requests ($code)', async ({ resource, code }) => {
    await imageProfilesService(admin, d).approve(input(), project);
    const result = await imageProfilesService(researcher, d).preflight(spec(resource), project);
    expect(result.status).toBe('blocked');
    expect(result.findings.some(f => f.code === code)).toBe(true);
  });
  it('does not treat aggregate VRAM or a mismatched architecture as compatible', async () => {
    await imageProfilesService(admin, d).approve({ ...input(), requirements: { ...input().requirements, minGpuMemoryMiB: 80 * 1024 } }, project);
    expect((await imageProfilesService(researcher, d).preflight(spec(), project)).tasks[0].hardwareCompatibility).toBe('incompatible');
    const hardware = await d.hardware();
    hardware.nodes[0].architecture = 'arm64';
    d.hardware = async () => hardware;
    expect((await imageProfilesService(researcher, d).preflight(spec(), project)).status).toBe('blocked');
  });
  it('reports unavailable catalog and empty current nodes without inventing readiness', async () => {
    await imageProfilesService(admin, d).approve(input(), project);
    const hardware = await d.hardware();
    hardware.nodes[0].catalog = undefined; hardware.catalogAvailable = false;
    d.hardware = async () => hardware;
    const result = await imageProfilesService(researcher, d).preflight(spec(), project);
    expect(result.tasks[0].hardwareCompatibility).toBe('unknown');
    expect(result.tasks[0].compatibleNodes).toEqual([]);
    d.hardware = async () => ({ ...hardware, nodes: [] });
    expect((await imageProfilesService(researcher, d).preflight(spec(), project)).findings.some(f => f.code === 'no_current_nodes')).toBe(true);
  });
  it('does not probe unapproved or foreign-registry task images', async () => {
    const result = await imageProfilesService(researcher, d).preflight(spec({}, 'https://evil.example/image'), project);
    expect(result.status).toBe('blocked');
    expect(d.inspectImage).not.toHaveBeenCalled();
    expect(d.hardware).not.toHaveBeenCalled();
  });
  it('rechecks membership after slow inspection before returning pins', async () => {
    await imageProfilesService(admin, d).approve(input(), project);
    const image = await d.inspectImage(uri);
    d.inspectImage = async () => {
      await d.repo.kv.put({ pk: 'PROJECT#a', sk: 'META', ...project, members: {} });
      return image;
    };
    await expect(imageProfilesService(researcher, d).preflight(spec(), project)).rejects.toMatchObject({ status: 403 });
  });
  it('does not return a usable pin if an administrator disables approval during inspection', async () => {
    const adminService = imageProfilesService(admin, d);
    await adminService.approve(input(), project);
    const image = await d.inspectImage(uri);
    d.inspectImage = async () => { await adminService.disable('training', project); return image; };
    const result = await imageProfilesService(researcher, d).preflight(spec(), project);
    expect(result.status).toBe('blocked');
    expect(result.resolvedImageDigests).toEqual({});
    expect(result.findings.some(f => f.code === 'image_profile_changed')).toBe(true);
  });
  it('uses one fresh image observation for repeated references within the same preflight', async () => {
    await imageProfilesService(admin, d).approve(input(), project);
    vi.mocked(d.inspectImage).mockClear();
    const workflow = spec();
    workflow.workflow.tasks.push({ ...workflow.workflow.tasks[0], name: 'evaluate' });
    const result = await imageProfilesService(researcher, d).preflight(workflow, project);
    expect(result.resolvedImageDigests).toEqual({ train: resolved, evaluate: resolved });
    expect(d.inspectImage).toHaveBeenCalledTimes(1);
    expect(d.hardware).toHaveBeenCalledTimes(1);
  });
});
