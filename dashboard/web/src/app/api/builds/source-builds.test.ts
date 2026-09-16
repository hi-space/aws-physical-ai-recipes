import { beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const provider = vi.hoisted(() => ({ checkTarget: vi.fn(), start: vi.fn(), logs: vi.fn() }));
vi.mock('@/server/aws/source-builds', () => ({ createSourceBuildProvider: () => provider }));
import { Repo, setRepoForTests } from '@/server/store/repo';
import { MemoryKV } from '@/server/store/dynamo';
import { resetConfigForTests } from '@/server/config';
import { GET as sources, POST as register } from './sources/route';
import { GET as builds, POST as start } from './runs/route';
import { GET as detail, POST as cancel } from './runs/[id]/route';

let repo: Repo;
const origin = 'https://builds.example';
function request(path: string, method = 'GET', json?: unknown, subject = 'admin', project = 'a') {
  return new NextRequest(origin + path, { method, headers: { origin, 'content-type': 'application/json', 'x-pai-user': subject,
    'x-pai-subject': subject, 'x-pai-role': subject === 'viewer' ? 'viewer' : 'researcher', 'x-pai-project': project,
    'idempotency-key': 'request-key-0001' }, ...(json ? { body: JSON.stringify(json) } : {}) });
}
beforeEach(async () => {
  vi.clearAllMocks(); vi.stubEnv('AUTH_MODE', 'dev'); vi.stubEnv('DASHBOARD_ORIGIN', origin);
  vi.stubEnv('ACCOUNT_ID', '123456789012'); vi.stubEnv('AWS_REGION', 'us-east-1');
  vi.stubEnv('SOURCE_BUILD_TARGETS_JSON', JSON.stringify([{ id: 'a-build', projectId: 'a', codeBuildProjectName: 'source-a',
    sourceType: 'GITHUB', repositoryUrl: 'https://github.com/example/source', serviceRoleArn: 'arn:aws:iam::123456789012:role/source-a',
    builderImage: '123456789012.dkr.ecr.us-east-1.amazonaws.com/builder@sha256:' + 'a'.repeat(64),
    outputRepositoryName: 'physical-ai/projects/a/images' }]));
  resetConfigForTests(); repo = new Repo(new MemoryKV()); setRepoForTests(repo);
  await repo.kv.put({ pk: 'PROJECT#a', sk: 'META', id: 'a', name: 'A', namespace: 'hyperpod-ns-a',
    members: { admin: 'project-admin', user: 'researcher', viewer: 'viewer' }, updatedAt: 'x' });
  provider.checkTarget.mockResolvedValue({ configurationHash: 'c'.repeat(64) });
});
it('keeps source registration project-admin only and never accepts arbitrary build overrides', async () => {
  expect((await register(request('/api/builds/sources', 'POST', { targetId: 'a-build', name: 'Source' }, 'user'))).status).toBe(403);
  expect((await register(request('/api/builds/sources', 'POST', { targetId: 'a-build', name: 'Source' }, 'viewer'))).status).toBe(403);
  expect(provider.checkTarget).not.toHaveBeenCalled();
  expect((await start(request('/api/builds/runs', 'POST', { sourceId: 'src-' + 'a'.repeat(32), commit: 'a'.repeat(40), buildspecOverride: 'bad' }))).status).toBe(400);
  expect(provider.start).not.toHaveBeenCalled();
});
it('returns a durable202 source intent and safe scoped metadata for viewers', async () => {
  const registered = await register(request('/api/builds/sources', 'POST', { targetId: 'a-build', name: 'Source' }));
  expect(registered.status).toBe(200);
  const source = await registered.json();
  const response = await start(request('/api/builds/runs', 'POST', { sourceId: source.id, commit: 'a'.repeat(40) }, 'user'));
  expect(response.status).toBe(202);
  const run = await response.json(); expect(run.state).toBe('STARTING');
  const list = await (await builds(request('/api/builds/runs', 'GET', undefined, 'viewer'))).json();
  expect(list.items).toHaveLength(1);
  expect(JSON.stringify([source, run, list])).not.toMatch(/serviceRoleArn|idempotencyToken|leaseHolder|PAI_REQUEST_ID/);
  expect(provider.start).not.toHaveBeenCalled();
  expect((await cancel(request('/api/builds/runs/' + run.id, 'POST', { action: 'cancel' }, 'viewer'), { params: Promise.resolve({ id: run.id }) })).status).toBe(403);
});
it('rechecks membership and hides foreign run IDs before provider calls', async () => {
  const registered = await register(request('/api/builds/sources', 'POST', { targetId: 'a-build', name: 'Source' }));
  expect(registered.status).toBe(200);
  const source = await registered.json();
  const started = await start(request('/api/builds/runs', 'POST', { sourceId: source.id, commit: 'a'.repeat(40) }, 'user'));
  expect(started.status).toBe(202);
  const run = await started.json();
  await repo.kv.put({ pk: 'PROJECT#b', sk: 'META', id: 'b', namespace: 'hyperpod-ns-b', members: { user: 'researcher' } });
  expect((await detail(request('/api/builds/runs/' + run.id, 'GET', undefined, 'user', 'b'), { params: Promise.resolve({ id: run.id }) })).status).toBe(404);
  await repo.kv.put({ pk: 'PROJECT#a', sk: 'META', id: 'a', namespace: 'hyperpod-ns-a', members: {}, updatedAt: 'revoked' });
  expect((await sources(request('/api/builds/sources', 'GET', undefined, 'user'))).status).toBe(403);
});
