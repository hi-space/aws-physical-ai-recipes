import { beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const ssm = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('@/server/aws/clients', async original => ({ ...await original<typeof import('@/server/aws/clients')>(), ssm: () => ssm }));
vi.mock('@/server/services/webhook-http', async original => ({ ...await original<typeof import('@/server/services/webhook-http')>(),
  resolveWebhookTarget: vi.fn(async () => ({ hostname: 'hooks.example.com', address: '93.184.216.34', family: 4, path: '/private' })) }));
import { Repo, setRepoForTests } from '@/server/store/repo';
import { MemoryKV } from '@/server/store/dynamo';
import { resetConfigForTests } from '@/server/config';
import { GET, POST } from './route';
import { POST as rotate } from './[id]/rotate/route';
import { DELETE } from './[id]/route';

const origin = 'https://webhooks.example';
const secret = 'private-key-'.repeat(4);
const input = { name: 'Training events', endpointUrl: 'https://hooks.example.com/secret-path?key=hidden', secret };
let repo: Repo;
// admin ⇒ project-admin, viewer ⇒ project viewer, researcher ⇒ plain researcher member.
const groupsFor = (subject: string) => subject === 'admin' ? 'researchers,proj-a-admin' : subject === 'viewer' ? 'viewers,proj-a' : 'researchers,proj-a';
function request(method = 'GET', json?: unknown, subject = 'admin', headers: Record<string, string> = {}) {
  return new NextRequest(origin + '/api/webhooks', { method, headers: { origin, 'content-type': 'application/json',
    'x-pai-user': subject, 'x-pai-subject': subject, 'x-pai-role': subject === 'viewer' ? 'viewer' : 'researcher', 'x-pai-groups': groupsFor(subject), 'x-pai-project': 'a', ...headers },
  ...(json === undefined ? {} : { body: JSON.stringify(json) }) });
}
beforeEach(async () => {
  vi.clearAllMocks(); vi.stubEnv('AUTH_MODE', 'dev'); vi.stubEnv('DASHBOARD_ORIGIN', origin); resetConfigForTests();
  repo = new Repo(new MemoryKV()); setRepoForTests(repo);
  await repo.kv.put({ pk: 'PROJECT#a', sk: 'META', id: 'a', name: 'A', namespace: 'hyperpod-ns-a', updatedAt: 'x' });
  ssm.send.mockImplementation(async command => {
    if (command.constructor.name === 'PutParameterCommand') return { Version: 1 };
    throw new Error('Unexpected secret read');
  });
});
it('rejects viewer/researcher/cross-origin management before accessing the secret store', async () => {
  expect((await POST(request('POST', input, 'viewer'))).status).toBe(403);
  expect((await POST(request('POST', input, 'researcher'))).status).toBe(403);
  expect((await POST(request('POST', input, 'admin', { origin: 'https://sibling.example' }))).status).toBe(403);
  expect(ssm.send).not.toHaveBeenCalled();
});
it('uses SecureString and returns no endpoint, signing key, or SSM reference in create/list/rotate responses', async () => {
  const created = await POST(request('POST', input));
  expect(created.status).toBe(200);
  const hook = await created.json();
  const command = ssm.send.mock.calls[0][0];
  expect(command.input).toMatchObject({ Type: 'SecureString', Name: `/physical-ai/projects/a/webhooks/${hook.id}` });
  expect(JSON.parse(command.input.Value)).toMatchObject({ endpointUrl: input.endpointUrl, secret });
  const listed = await GET(request('GET', undefined, 'viewer'));
  const output = [hook, await listed.json()];
  const changed = await rotate(request('POST', { endpointUrl: input.endpointUrl, secret: 'replacement-'.repeat(4) }), { params: Promise.resolve({ id: hook.id }) });
  output.push(await changed.json());
  expect(JSON.stringify(output)).not.toMatch(/secret-path|private-key|replacement-|physical-ai\/projects/);
});
it('requires current membership and prevents cross-project identifier access', async () => {
  const hook = await (await POST(request('POST', input))).json();
  expect((await DELETE(request('DELETE', undefined, 'admin', { 'x-pai-project': 'b' }), { params: Promise.resolve({ id: hook.id }) })).status).toBe(403);
  // Member group removed entirely ⇒ no project membership at all.
  expect((await GET(request('GET', undefined, 'admin', { 'x-pai-groups': 'researchers' }))).status).toBe(403);
});
