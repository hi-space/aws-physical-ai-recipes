import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Repo } from '../store/repo';
import { MemoryKV } from '../store/dynamo';
import {
  assertNamespaceAccess, assertStorageScope, canReadResource, filterAccessible, listProjects, memberRole, namespaceOf,
  projectFromItem, projectIdFromNamespace, projectIdPattern, projectItem, queueOf, resolveProject, updateProjectMeta,
} from './projects';
import { projectFixture, putProject, testSession } from './session.test-helpers';

const admin = testSession('admin', 'admin-sub', 'admin');
const alice = testSession('alice', 'alice-sub', 'researcher', ['proj-team-a']);
const lead = testSession('lead', 'lead-sub', 'viewer', ['proj-team-a-admin']);
const bob = testSession('bob', 'bob-sub', 'researcher');
let repo: Repo;
beforeEach(async () => {
  repo = new Repo(new MemoryKV());
  await putProject(repo.kv, 'team-a');
  await putProject(repo.kv, 'team-b', { backendId: 'gpu-2' });
});

describe('derived namespace and queue', () => {
  it('derives from the id and never persists them', () => {
    const p = projectFixture('team-a');
    expect(namespaceOf(p)).toBe('hyperpod-ns-team-a');
    expect(queueOf(p)).toBe('hyperpod-ns-team-a-localqueue');
    const item = projectItem(p);
    expect(item).not.toHaveProperty('namespace');
    expect(item).not.toHaveProperty('queue');
    expect(item).toMatchObject({ pk: 'PROJECT#team-a', sk: 'META', gsi1pk: 'TYPE#PROJECT', gsi1sk: 'team-a' });
    // Stale persisted values from the old schema are ignored on read.
    expect(projectFromItem({ ...item, namespace: 'hyperpod-ns-wrong', queue: 'q', members: { x: 'viewer' } })).toMatchObject({ namespace: 'hyperpod-ns-team-a', queue: 'hyperpod-ns-team-a-localqueue' });
    expect(projectFromItem(item)).not.toHaveProperty('members');
    expect(projectIdFromNamespace('hyperpod-ns-team-a')).toBe('team-a');
    expect(projectIdFromNamespace('kube-system')).toBeUndefined();
    expect(projectIdPattern.test('team-a')).toBe(true);
    expect(projectIdPattern.test('team-admin')).toBe(false);
    expect(projectIdFromNamespace('hyperpod-ns-team-admin')).toBeUndefined();
  });
});

describe('memberRole', () => {
  it('reads the session groups and lets platform admins through', () => {
    expect(memberRole(alice, { id: 'team-a' })).toBe('researcher');
    expect(memberRole(lead, { id: 'team-a' })).toBe('project-admin');
    expect(memberRole(bob, { id: 'team-a' })).toBeUndefined();
    expect(memberRole(admin, { id: 'team-a' })).toBe('project-admin');
  });
  it('confines API tokens to their bound project', () => {
    const token = { ...alice, authMethod: 'token' as const, tokenProjectId: 'team-b' };
    expect(memberRole(token, { id: 'team-a' })).toBeUndefined();
    expect(memberRole({ ...admin, tokenProjectId: 'team-b' }, { id: 'team-a' })).toBeUndefined();
  });
});

describe('project authorization', () => {
  it('lists and resolves by membership without any Cognito call', async () => {
    expect((await listProjects(alice, repo)).map((p) => p.id)).toEqual(['team-a']);
    expect((await listProjects(admin, repo)).map((p) => p.id)).toEqual(['team-a', 'team-b']);
    expect(await listProjects(bob, repo)).toEqual([]);
    expect((await resolveProject(alice, 'team-a', repo)).namespace).toBe('hyperpod-ns-team-a');
    expect((await resolveProject(alice, undefined, repo)).id).toBe('team-a');
    await expect(resolveProject(bob, 'team-a', repo)).rejects.toThrow(/project/);
    await expect(resolveProject(bob, undefined, repo)).rejects.toThrow(/project/);
    await expect(resolveProject(alice, 'team-a', repo, 'project-admin')).rejects.toThrow(/project-admin/);
    expect((await resolveProject(lead, 'team-a', repo, 'project-admin')).id).toBe('team-a');
  });
  it('checks resources from the session alone (no kv read)', async () => {
    const spy = vi.spyOn(repo.kv, 'get');
    expect(await canReadResource(alice, { projectId: 'team-a', owner: 'other' }, repo)).toBe(true);
    expect(await canReadResource(bob, { projectId: 'team-a', owner: 'bob' }, repo)).toBe(false);
    expect(await canReadResource({ ...alice, tokenProjectId: 'team-b' }, { projectId: 'team-a' }, repo)).toBe(false);
    const rows = [{ projectId: 'team-a' }, { projectId: 'team-b' }, { owner: 'alice' }, { owner: 'bob' }];
    expect(await filterAccessible(alice, rows)).toEqual([{ projectId: 'team-a' }, { owner: 'alice' }]);
    expect(spy).not.toHaveBeenCalled();
  });
  it('keeps legacy records visible to their owner or platform admin', async () => {
    expect(await canReadResource(alice, { owner: 'alice' }, repo)).toBe(true);
    expect(await canReadResource(bob, { owner: 'alice' }, repo)).toBe(false);
    expect(await canReadResource(admin, { owner: 'alice' }, repo)).toBe(true);
  });
  it('maps a namespace back to a project for namespace access', async () => {
    await expect(assertNamespaceAccess(alice, 'hyperpod-ns-team-a', false, 'default', repo)).resolves.toBeUndefined();
    await expect(assertNamespaceAccess(alice, 'hyperpod-ns-team-a', false, 'gpu-2', repo)).rejects.toThrow(/namespace/);
    await expect(assertNamespaceAccess(bob, 'hyperpod-ns-team-a', false, 'default', repo)).rejects.toThrow(/namespace/);
    await expect(assertNamespaceAccess(lead, 'hyperpod-ns-team-a', true, 'default', repo)).resolves.toBeUndefined();
    await expect(assertNamespaceAccess(testSession('v', 'v-sub', 'viewer', ['proj-team-a']), 'hyperpod-ns-team-a', true, 'default', repo)).rejects.toThrow(/read-only/);
    await expect(assertNamespaceAccess(alice, 'kube-system', false, 'default', repo)).rejects.toThrow(/System/);
    await expect(assertNamespaceAccess(alice, 'hyperpod-ns-ghost', false, 'default', repo)).rejects.toThrow(/namespace/);
  });
  it('lets project admins edit metadata only', async () => {
    const updated = await updateProjectMeta(lead, 'team-a', { name: 'Team A', description: 'robots' }, repo);
    expect(updated).toMatchObject({ name: 'Team A', description: 'robots', namespace: 'hyperpod-ns-team-a' });
    expect(await repo.kv.get('PROJECT#team-a', 'META')).not.toHaveProperty('namespace');
    await expect(updateProjectMeta(alice, 'team-a', { name: 'x' }, repo)).rejects.toThrow(/project-admin/);
    await expect(updateProjectMeta(lead, 'team-a', { id: 'other' } as never, repo)).rejects.toThrow();
  });
  it('allows only the project prefixes for ordinary storage access', () => {
    const project = projectFixture('team-a');
    expect(() => assertStorageScope(alice, project, 'datasets/projects/team-a/v1/data.parquet')).not.toThrow();
    expect(() => assertStorageScope(alice, project, 'checkpoints/projects/team-a/runs/abc/model.pt')).not.toThrow();
    expect(() => assertStorageScope(alice, project, 'datasets/projects/team-ab/v1/data.parquet')).toThrow();
    expect(() => assertStorageScope(alice, project, 'datasets/projects/team-a/../team-b/data')).toThrow();
  });
});
