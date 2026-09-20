import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  describeComputeQuota: vi.fn(), describeCluster: vi.fn(), listComputeQuotas: vi.fn(), listLocalQueues: vi.fn(),
  createProjectGroups: vi.fn(), deleteProjectGroups: vi.fn(), listUsers: vi.fn(), setProjectGroups: vi.fn(),
}));
vi.mock('@/server/aws/hyperpod', async (original) => ({ ...await original<typeof import('@/server/aws/hyperpod')>(),
  describeComputeQuota: mocks.describeComputeQuota, describeCluster: mocks.describeCluster, listComputeQuotas: mocks.listComputeQuotas }));
vi.mock('@/server/k8s/kueue', async (original) => ({ ...await original<typeof import('@/server/k8s/kueue')>(), listLocalQueues: mocks.listLocalQueues }));
vi.mock('@/server/aws/cognito', async (original) => ({ ...await original<typeof import('@/server/aws/cognito')>(),
  createProjectGroups: mocks.createProjectGroups, deleteProjectGroups: mocks.deleteProjectGroups, listUsers: mocks.listUsers, setProjectGroups: mocks.setProjectGroups }));

import { resetConfigForTests } from '@/server/config';
import { MemoryKV } from '@/server/store/dynamo';
import { Repo, setRepoForTests } from '@/server/store/repo';
import { resetAttachmentCacheForTests } from '@/server/auth/project-adoption';
import { SESSION_HEADERS } from '@/server/auth/session';
import { GET as list, POST as adopt } from './route';
import { DELETE as remove, GET as detail, PATCH as patch } from './[id]/route';
import { GET as members } from './[id]/members/route';
import { PUT as setMember } from './[id]/members/[username]/route';

const origin = 'https://projects.example';
const arn = 'arn:aws:sagemaker:us-east-1:123456789012:cluster/hp';
function request(path: string, opts: { method?: string; role?: string; groups?: string[]; body?: unknown } = {}) {
  return new NextRequest(origin + path, { method: opts.method ?? 'GET', headers: {
    [SESSION_HEADERS.user]: 'u', [SESSION_HEADERS.subject]: 'u-sub', [SESSION_HEADERS.role]: opts.role ?? 'admin',
    [SESSION_HEADERS.groups]: (opts.groups ?? [opts.role === 'researcher' ? 'researchers' : opts.role === 'viewer' ? 'viewers' : 'admins']).join(','),
    [SESSION_HEADERS.authMethod]: 'alb', origin, 'content-type': 'application/json',
  }, ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }) });
}
const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });

beforeEach(() => {
  vi.clearAllMocks(); resetAttachmentCacheForTests();
  vi.stubEnv('AUTH_MODE', 'dev'); vi.stubEnv('DASHBOARD_ORIGIN', origin);
  vi.stubEnv('EKS_CLUSTER_NAME', 'eks'); vi.stubEnv('HYPERPOD_EKS_CLUSTER_NAME', 'hp'); vi.stubEnv('EKS_DATA_BUCKET', 'data');
  resetConfigForTests();
  setRepoForTests(new Repo(new MemoryKV()));
  mocks.describeComputeQuota.mockResolvedValue({ ComputeQuotaId: 'q1', ComputeQuotaTarget: { TeamName: 'team-a' }, ClusterArn: arn, Status: 'Created' });
  mocks.describeCluster.mockResolvedValue({ ClusterArn: arn });
  mocks.listComputeQuotas.mockResolvedValue([{ ComputeQuotaId: 'q1', ComputeQuotaTarget: { TeamName: 'team-a' } }]);
  mocks.listLocalQueues.mockResolvedValue([{ metadata: { name: 'hyperpod-ns-team-a-localqueue', namespace: 'hyperpod-ns-team-a' }, spec: { clusterQueue: 'cq' } }]);
  mocks.listUsers.mockResolvedValue([{ username: 'alice', subject: 'a-sub', email: 'a@x', groups: ['researchers', 'proj-team-a'] }]);
});

describe('/api/projects', () => {
  it('adopts, lists with attachment + myRole, patches, manages members and deletes', async () => {
    const created = await adopt(request('/api/projects', { method: 'POST', body: { computeQuotaId: 'q1' } }));
    expect(created.status).toBe(200);
    expect(await created.json()).toMatchObject({ id: 'team-a', namespace: 'hyperpod-ns-team-a', attachment: 'ATTACHED', myRole: 'project-admin' });

    const asMember = await list(request('/api/projects', { role: 'researcher', groups: ['researchers', 'proj-team-a'] }));
    expect(await asMember.json()).toEqual([expect.objectContaining({ id: 'team-a', myRole: 'researcher', attachment: 'ATTACHED' })]);
    const asStranger = await list(request('/api/projects', { role: 'researcher' }));
    expect(await asStranger.json()).toEqual([]);

    const patched = await patch(request('/api/projects/team-a', { method: 'PATCH', body: { name: 'Team A' } }), params({ id: 'team-a' }));
    expect(await patched.json()).toMatchObject({ name: 'Team A' });
    expect((await patch(request('/api/projects/team-a', { method: 'PATCH', role: 'researcher', groups: ['researchers', 'proj-team-a'], body: { name: 'x' } }), params({ id: 'team-a' }))).status).toBe(403);

    const listed = await members(request('/api/projects/team-a/members', { role: 'researcher', groups: ['viewers', 'proj-team-a-admin'] }), params({ id: 'team-a' }));
    expect(await listed.json()).toEqual({ members: [{ username: 'alice', subject: 'a-sub', email: 'a@x', role: 'researcher' }] });
    const put = await setMember(request('/api/projects/team-a/members/bob', { method: 'PUT', body: { role: 'member' } }), params({ id: 'team-a', username: 'bob' }));
    expect(put.status).toBe(200);
    expect(mocks.setProjectGroups).toHaveBeenCalledWith('bob', 'team-a', 'member');

    mocks.listComputeQuotas.mockResolvedValue([]); resetAttachmentCacheForTests();
    expect(await (await detail(request('/api/projects/team-a'), params({ id: 'team-a' }))).json()).toMatchObject({ attachment: 'DETACHED' });

    expect((await remove(request('/api/projects/team-a', { method: 'DELETE', role: 'researcher' }), params({ id: 'team-a' }))).status).toBe(403);
    expect((await remove(request('/api/projects/team-a', { method: 'DELETE' }), params({ id: 'team-a' }))).status).toBe(200);
    expect(await (await list(request('/api/projects'))).json()).toEqual([]);
  });
  it('rejects the legacy namespace body', async () => {
    const res = await adopt(request('/api/projects', { method: 'POST', body: { id: 'x', name: 'x', namespace: 'hyperpod-ns-x' } }));
    expect(res.status).toBe(400);
  });
});
