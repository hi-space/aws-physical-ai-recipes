import { beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const probes = vi.hoisted(() => ({ image: vi.fn(), hardware: vi.fn() }));
vi.mock('@/server/aws/ecr-inspection', async original => ({
  ...await original<typeof import('@/server/aws/ecr-inspection')>(), inspectEcrImage: probes.image,
}));
vi.mock('@/server/aws/hardware-inspection', async original => ({
  ...await original<typeof import('@/server/aws/hardware-inspection')>(), inspectHardware: probes.hardware,
}));
import { Repo, setRepoForTests } from '@/server/store/repo';
import { MemoryKV } from '@/server/store/dynamo';
import { resetConfigForTests } from '@/server/config';
import { GET as list, POST as approve } from './route';
import { GET as detail, DELETE as disable } from './[id]/route';
import { POST as preflight } from './preflight/route';

const origin = 'https://image-profiles.example';
const uri = '123456789012.dkr.ecr.us-east-1.amazonaws.com/recipes/cpu:stable';
const digest = 'sha256:' + 'a'.repeat(64);
const input = { id: 'cpu', name: 'CPU image', image: uri };
let repo: Repo;
function request(path: string, method = 'GET', json?: unknown, role = 'admin', headers: Record<string, string> = {}) {
  return new NextRequest(origin + '/api/image-profiles' + path, {
    method, headers: { origin, 'content-type': 'application/json', 'x-pai-user': 'alice', 'x-pai-subject': 'sub',
      'x-pai-role': role, 'x-pai-groups': `${role === 'admin' ? 'admins' : 'researchers'},proj-a`, 'x-pai-project': 'a', ...headers }, ...(json === undefined ? {} : { body: JSON.stringify(json) }),
  });
}
beforeEach(async () => {
  vi.clearAllMocks(); vi.stubEnv('AUTH_MODE', 'dev'); vi.stubEnv('ACCOUNT_ID', '123456789012'); vi.stubEnv('AWS_REGION', 'us-east-1'); vi.stubEnv('DASHBOARD_ORIGIN', origin);
  resetConfigForTests(); repo = new Repo(new MemoryKV()); setRepoForTests(repo);
  await repo.kv.put({ pk: 'PROJECT#a', sk: 'META', id: 'a', name: 'A', namespace: 'hyperpod-ns-a', queue: 'q-a', updatedAt: 'x' });
  probes.image.mockResolvedValue({ requestedImage: uri, resolvedImage: uri.replace(':stable', '@' + digest), digest, architectures: ['amd64'],
    manifests: [{ digest, configDigest: 'sha256:' + 'b'.repeat(64), architecture: 'amd64', os: 'linux' }], source: 'ecr-manifest-config', inspectedAt: '2026-09-16T12:00:00Z', repository: 'recipes/cpu', accountId: '123456789012', region: 'us-east-1' });
  probes.hardware.mockResolvedValue({ source: 'eks-nodes+ec2-instance-types', checkedAt: '2026-09-16T12:00:00Z', catalogAvailable: true, nodes: [] });
});
it('requires administrator and same-origin approval before invoking ECR', async () => {
  expect((await approve(request('', 'POST', input, 'researcher'))).status).toBe(403);
  expect((await approve(request('', 'POST', input, 'admin', { origin: 'https://sibling.example' }))).status).toBe(403);
  expect(probes.image).not.toHaveBeenCalled();
});
it('lists project approvals and reads exact immutable revisions', async () => {
  expect((await approve(request('', 'POST', input))).status).toBe(200);
  expect((await approve(request('', 'POST', { ...input, name: 'Updated', expectedVersion: 1 }))).status).toBe(200);
  const result = await list(request('', 'GET', undefined, 'researcher'));
  expect((await result.json()).profiles[0]).toMatchObject({ version: 2, name: 'Updated' });
  const old = await detail(request('/cpu?version=1'), { params: Promise.resolve({ id: 'cpu' }) });
  expect(await old.json()).toMatchObject({ version: 1, name: 'CPU image' });
});
it('enforces fresh membership and cannot read a different project through the selected header', async () => {
  await approve(request('', 'POST', input));
  expect((await list(request('', 'GET', undefined, 'researcher', { 'x-pai-project': 'b' }))).status).toBe(403);
  // Member group removed entirely ⇒ no project membership at all.
  expect((await list(request('', 'GET', undefined, 'researcher', { 'x-pai-groups': 'researchers' }))).status).toBe(403);
});
it('preflights without launching work and disabling approval blocks subsequent use', async () => {
  await approve(request('', 'POST', input));
  const yaml = JSON.stringify({ workflow: { name: 'check', resources: { cpu: { cpu: 1, memory: '1Gi' } }, tasks: [{ name: 'run', resource: 'cpu', image: uri, command: ['true'] }] } });
  const first = await preflight(request('/preflight', 'POST', { yaml }, 'researcher'));
  expect(first.status).toBe(200);
  expect((await first.json()).resolvedImageDigests.run).toBe(uri.replace(':stable', '@' + digest));
  expect((await repo.listWorkflows()).length).toBe(0);
  expect((await disable(request('/cpu', 'DELETE'), { params: Promise.resolve({ id: 'cpu' }) })).status).toBe(200);
  const after = await preflight(request('/preflight', 'POST', { yaml }, 'researcher'));
  expect((await after.json()).findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'image_profile_unapproved' })]));
});
