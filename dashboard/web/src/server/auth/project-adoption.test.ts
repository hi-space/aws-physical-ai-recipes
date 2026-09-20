import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Repo } from '../store/repo';
import { MemoryKV } from '../store/dynamo';
import { adoptProject, attachmentsFor, deleteProject, resetAttachmentCacheForTests, type AdoptionDeps } from './project-adoption';
import { getProject } from './projects';
import { projectFixture, putProject, testClusterArn, testSession } from './session.test-helpers';

const admin = testSession('admin', 'admin-sub', 'admin');
const alice = testSession('alice', 'alice-sub', 'researcher', ['proj-team-a-admin']);
let repo: Repo, deps: AdoptionDeps, quotas: Array<{ id: string; teamName?: string; clusterArn?: string; status?: string }>;
beforeEach(() => {
  repo = new Repo(new MemoryKV());
  resetAttachmentCacheForTests();
  quotas = [{ id: 'q-team-a', teamName: 'team-a', clusterArn: testClusterArn, status: 'Created' }, { id: 'q-9lives', teamName: '9lives', clusterArn: testClusterArn }];
  deps = {
    repo, now: () => new Date('2026-09-20T00:00:00Z'),
    describeComputeQuota: vi.fn(async (id: string) => { const q = quotas.find((x) => x.id === id); if (!q) throw Object.assign(new Error('nf'), { name: 'ResourceNotFound' }); return q; }),
    currentClusterArn: vi.fn(async () => testClusterArn),
    localQueueExists: vi.fn(async (namespace: string, name: string) => namespace === 'hyperpod-ns-team-a' && name === 'hyperpod-ns-team-a-localqueue'),
    createProjectGroups: vi.fn(async () => undefined),
    deleteProjectGroups: vi.fn(async () => undefined),
    listComputeQuotas: vi.fn(async () => quotas.map((q) => ({ id: q.id, teamName: q.teamName }))),
  };
});

describe('adoptProject', () => {
  it('adopts a ComputeQuota as a project keyed by TeamName and reserves namespace + quota', async () => {
    const project = await adoptProject(admin, { computeQuotaId: 'q-team-a' }, deps);
    expect(project).toMatchObject({ id: 'team-a', name: 'team-a', computeQuotaId: 'q-team-a', clusterArn: testClusterArn, namespace: 'hyperpod-ns-team-a', queue: 'hyperpod-ns-team-a-localqueue', credentialRefs: [] });
    expect(project.backendId).toBe('default');
    expect(deps.createProjectGroups).toHaveBeenCalledWith('team-a');
    expect(await repo.kv.get('PROJECT#team-a', 'META')).not.toHaveProperty('namespace');
    expect(await repo.kv.get('PROJECT_NAMESPACE#default#hyperpod-ns-team-a', 'OWNER')).toMatchObject({ projectId: 'team-a' });
    expect(await repo.kv.get('PROJECT_NAMESPACE#hyperpod-ns-team-a', 'OWNER')).toMatchObject({ projectId: 'team-a' });
    expect(await repo.kv.get('PROJECT_QUOTA#q-team-a', 'OWNER')).toMatchObject({ projectId: 'team-a' });
  });
  it('honours an explicit name/description and requires platform admin', async () => {
    expect((await adoptProject(admin, { computeQuotaId: 'q-team-a', name: 'Team A', description: 'arms' }, deps))).toMatchObject({ name: 'Team A', description: 'arms' });
    await expect(adoptProject(alice, { computeQuotaId: 'q-team-a' }, deps)).rejects.toThrow(/admin/);
  });
  it('rejects team names outside the project id rule, foreign clusters, missing queues and unknown quotas', async () => {
    await expect(adoptProject(admin, { computeQuotaId: 'q-9lives' }, deps)).rejects.toThrow(/식별자 규칙/);
    quotas[0].clusterArn = 'arn:aws:sagemaker:us-east-1:123456789012:cluster/other';
    await expect(adoptProject(admin, { computeQuotaId: 'q-team-a' }, deps)).rejects.toThrow(/cluster/i);
    quotas[0].clusterArn = testClusterArn; quotas[0].teamName = 'team-c';
    await expect(adoptProject(admin, { computeQuotaId: 'q-team-a' }, deps)).rejects.toThrow(/큐/);
    await expect(adoptProject(admin, { computeQuotaId: 'nope' }, deps)).rejects.toThrow(/ComputeQuota/);
  });
  it('refuses to adopt the same quota or team twice', async () => {
    await adoptProject(admin, { computeQuotaId: 'q-team-a' }, deps);
    await expect(adoptProject(admin, { computeQuotaId: 'q-team-a' }, deps)).rejects.toThrow(/이미 채택/);
    quotas.push({ id: 'q-dup', teamName: 'team-a', clusterArn: testClusterArn });
    await expect(adoptProject(admin, { computeQuotaId: 'q-dup' }, deps)).rejects.toThrow(/이미 채택/);
  });
  it('rejects at the reservation transaction when the quota or namespace is already held despite passing the pre-check', async () => {
    await repo.kv.put({ pk: 'PROJECT_QUOTA#q-team-a', sk: 'OWNER', projectId: 'ghost' });
    await expect(adoptProject(admin, { computeQuotaId: 'q-team-a' }, deps)).rejects.toThrow(/이미 채택/);
    expect(await repo.kv.get('PROJECT#team-a', 'META')).toBeUndefined();
  });
  it('rejects at the reservation transaction when the namespace is already held by another record', async () => {
    await repo.kv.put({ pk: 'PROJECT_NAMESPACE#default#hyperpod-ns-team-a', sk: 'OWNER', projectId: 'ghost' });
    await expect(adoptProject(admin, { computeQuotaId: 'q-team-a' }, deps)).rejects.toThrow(/이미 채택/);
    expect(await repo.kv.get('PROJECT#team-a', 'META')).toBeUndefined();
  });
});

describe('deleteProject', () => {
  it('removes the adoption record, reservations and groups but nothing else', async () => {
    await adoptProject(admin, { computeQuotaId: 'q-team-a' }, deps);
    await repo.kv.put({ pk: 'WF#run-1', sk: 'META', projectId: 'team-a' });
    await deleteProject(admin, 'team-a', deps);
    expect(await getProject('team-a', repo)).toBeUndefined();
    expect(await repo.kv.get('PROJECT_NAMESPACE#default#hyperpod-ns-team-a', 'OWNER')).toBeUndefined();
    expect(await repo.kv.get('PROJECT_NAMESPACE#hyperpod-ns-team-a', 'OWNER')).toBeUndefined();
    expect(await repo.kv.get('PROJECT_QUOTA#q-team-a', 'OWNER')).toBeUndefined();
    expect(await repo.kv.get('WF#run-1', 'META')).toBeDefined();
    expect(deps.deleteProjectGroups).toHaveBeenCalledWith('team-a');
    await expect(deleteProject(alice, 'team-a', deps)).rejects.toThrow(/admin/);
    await expect(deleteProject(admin, 'team-a', deps)).rejects.toThrow(/not found/i);
  });
});

describe('attachmentsFor', () => {
  it('reports ATTACHED / DETACHED / UNKNOWN and caches per cluster for 60s', async () => {
    const a = await putProject(repo.kv, 'team-a', { computeQuotaId: 'q-team-a' });
    const b = await putProject(repo.kv, 'team-b', { computeQuotaId: 'q-gone' });
    const c = projectFixture('team-c', { computeQuotaId: 'q-team-a', clusterArn: 'arn:aws:sagemaker:us-east-1:123456789012:cluster/broken' });
    (deps.listComputeQuotas as ReturnType<typeof vi.fn>).mockImplementation(async (arn: string) => { if (arn.endsWith('broken')) throw new Error('boom'); return quotas.map((q) => ({ id: q.id, teamName: q.teamName })); });
    const first = await attachmentsFor([a, b, c], deps);
    expect(first.get('team-a')).toBe('ATTACHED');
    expect(first.get('team-b')).toBe('DETACHED');
    expect(first.get('team-c')).toBe('UNKNOWN');
    await attachmentsFor([a, b], deps);
    expect(deps.listComputeQuotas).toHaveBeenCalledTimes(2); // one per distinct cluster; second call served from cache
    quotas[0].teamName = 'renamed';
    resetAttachmentCacheForTests();
    expect((await attachmentsFor([a], deps)).get('team-a')).toBe('DETACHED');
  });
});
