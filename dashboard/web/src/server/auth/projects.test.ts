import { beforeEach, describe, expect, it } from 'vitest';
import { Repo } from '../store/repo';
import { MemoryKV } from '../store/dynamo';
import { canReadResource, createProject, listProjects, resolveProject, assertStorageScope, type Project } from './projects';
import type { Session } from './session';

const admin: Session = { user: 'admin', subject: 'admin-sub', email: '', role: 'admin' };
const alice: Session = { user: 'alice', subject: 'alice-sub', email: '', role: 'researcher' };
const bob: Session = { user: 'bob', subject: 'bob-sub', email: '', role: 'researcher' };
let repo: Repo;
let project: Project;
beforeEach(async () => {
  repo = new Repo(new MemoryKV());
  project = await createProject(admin, {
    id: 'team-a', name: 'Team A', namespace: 'hyperpod-ns-team-a',
    members: { 'alice-sub': 'researcher' },
  }, repo);
});

describe('project authorization', () => {
  it('uses stable subjects and never falls back to another project', async () => {
    expect((await resolveProject(alice, 'team-a', repo)).id).toBe('team-a');
    expect(await listProjects(bob, repo)).toEqual([]);
    await expect(resolveProject(bob, 'team-a', repo)).rejects.toThrow(/project/);
    expect(await canReadResource(alice, { projectId: 'team-a', owner: 'other' }, repo)).toBe(true);
    expect(await canReadResource(bob, { projectId: 'team-a', owner: 'bob' }, repo)).toBe(false);
  });
  it('keeps legacy records visible to their owner or platform admin', async () => {
    expect(await canReadResource(alice, { owner: 'alice' }, repo)).toBe(true);
    expect(await canReadResource(bob, { owner: 'alice' }, repo)).toBe(false);
    expect(await canReadResource(admin, { owner: 'alice' }, repo)).toBe(true);
  });
  it('rejects duplicate namespaces and ungoverned namespace configuration', async () => {
    await expect(createProject(admin, { id: 'team-b', name: 'B', namespace: 'hyperpod-ns-team-a', members: {} }, repo)).rejects.toThrow(/namespace/);
    await expect(createProject(admin, { id: 'unsafe', name: 'Unsafe', namespace: 'kube-system', members: {} }, repo)).rejects.toThrow(/namespace/);
    await expect(createProject(alice, { id: 'new', name: 'New', namespace: 'hyperpod-ns-new', members: {} }, repo)).rejects.toThrow(/admin/);
  });
  it('allows only the project prefixes for ordinary storage access', () => {
    expect(() => assertStorageScope(alice, project, 'datasets/projects/team-a/v1/data.parquet')).not.toThrow();
    expect(() => assertStorageScope(alice, project, 'checkpoints/projects/team-a/runs/abc/model.pt')).not.toThrow();
    expect(() => assertStorageScope(alice, project, 'datasets/projects/team-ab/v1/data.parquet')).toThrow();
    expect(() => assertStorageScope(alice, project, 'checkpoints/projects/team-b/model.pt')).toThrow();
    expect(() => assertStorageScope(alice, project, 'datasets/projects/team-a/../team-b/data')).toThrow();
  });
});
