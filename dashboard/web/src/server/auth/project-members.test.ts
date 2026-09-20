import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Repo } from '../store/repo';
import { MemoryKV } from '../store/dynamo';
import { listProjectMembers, setProjectMembership, type MembersDeps } from './project-members';
import { putProject, testSession } from './session.test-helpers';

const lead = testSession('lead', 'lead-sub', 'viewer', ['proj-team-a-admin']);
const alice = testSession('alice', 'alice-sub', 'researcher', ['proj-team-a']);
let repo: Repo, deps: MembersDeps;
beforeEach(async () => {
  repo = new Repo(new MemoryKV());
  await putProject(repo.kv, 'team-a');
  deps = { repo,
    listUsers: vi.fn(async () => [
      { username: 'alice', subject: 'alice-sub', email: 'a@x', groups: ['researchers', 'proj-team-a'] },
      { username: 'lead', subject: 'lead-sub', email: 'l@x', groups: ['viewers', 'proj-team-a-admin'] },
      { username: 'bob', subject: 'bob-sub', email: 'b@x', groups: ['researchers', 'proj-team-b'] },
    ]),
    setProjectGroups: vi.fn(async () => undefined) };
});
describe('project members via Cognito groups', () => {
  it('lists only members of this project with their composed role', async () => {
    expect(await listProjectMembers(lead, 'team-a', deps)).toEqual([
      { username: 'alice', subject: 'alice-sub', email: 'a@x', role: 'researcher' },
      { username: 'lead', subject: 'lead-sub', email: 'l@x', role: 'project-admin' },
    ]);
    await expect(listProjectMembers(alice, 'team-a', deps)).rejects.toThrow(/project-admin/);
  });
  it('changes only this project\'s groups and validates the username', async () => {
    await setProjectMembership(lead, 'team-a', 'bob', 'member', deps);
    expect(deps.setProjectGroups).toHaveBeenCalledWith('bob', 'team-a', 'member');
    await setProjectMembership(lead, 'team-a', 'alice', null, deps);
    expect(deps.setProjectGroups).toHaveBeenCalledWith('alice', 'team-a', null);
    await expect(setProjectMembership(lead, 'team-a', 'bad user!', 'member', deps)).rejects.toThrow(/username/i);
    await expect(setProjectMembership(alice, 'team-a', 'bob', 'member', deps)).rejects.toThrow(/project-admin/);
  });
  it('turns an unknown Cognito username into a 400, but lets other errors propagate', async () => {
    deps.setProjectGroups = vi.fn(async () => {
      throw Object.assign(new Error('nf'), { name: 'UserNotFoundException' });
    });
    await expect(setProjectMembership(lead, 'team-a', 'ghost', 'member', deps)).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/username/i) });

    deps.setProjectGroups = vi.fn(async () => {
      throw new Error('boom');
    });
    await expect(setProjectMembership(lead, 'team-a', 'bob', 'member', deps)).rejects.toThrow('boom');
  });
});
