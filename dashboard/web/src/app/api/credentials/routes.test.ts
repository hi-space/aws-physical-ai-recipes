import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { MemoryKV } from '@/server/store/dynamo';
import { Repo, setRepoForTests } from '@/server/store/repo';
import { GET, POST } from './route';
import { POST as ROTATE } from './[id]/rotate/route';
import { DELETE } from './[id]/route';
import { POST as CREATE_TOKEN, GET as LIST_TOKENS } from '../tokens/route';
import { DELETE as REVOKE_TOKEN } from '../tokens/[id]/route';
import { verifyApiToken } from '@/server/auth/api-tokens';

const aws = vi.hoisted(() => ({ ssm: vi.fn(), cognito: vi.fn() }));
vi.mock('@/server/aws/clients', () => ({ ssm: () => ({ send: aws.ssm }), cognito: () => ({ send: aws.cognito }) }));
vi.mock('@/server/config', () => ({ config: () => ({ authMode: 'dev', tableName: 'test', dashboardOrigin: 'https://dashboard.test', cognitoUserPoolId: 'pool' }) }));
let kv: MemoryKV;
beforeEach(async () => {
  vi.clearAllMocks(); kv = new MemoryKV(); setRepoForTests(new Repo(kv));
  await kv.put({ pk: 'PROJECT#team', sk: 'META', gsi1pk: 'TYPE#PROJECT', gsi1sk: 'team', id: 'team', name: 'Team', namespace: 'hyperpod-ns-team', queue: 'q', credentialRefs: [] });
  aws.ssm.mockImplementation(async (command) => {
    if (command.constructor.name === 'PutParameterCommand') return { Version: 1 };
    if (command.constructor.name === 'DeleteParameterCommand') return {};
    throw new Error('Unexpected secret read');
  });
  aws.cognito.mockImplementation(async (command) => command.constructor.name === 'AdminGetUserCommand'
    ? { Username: 'alice', Enabled: true, UserAttributes: [{ Name: 'sub', Value: 'sub-a' }] }
    : { Groups: [{ GroupName: 'researchers' }, { GroupName: 'proj-team' }] });
});
function request(path: string, method = 'GET', json?: unknown, extra: Record<string, string> = {}) {
  return new NextRequest(`https://dashboard.test${path}`, { method, headers: { 'x-pai-user': 'alice', 'x-pai-subject': 'sub-a', 'x-pai-role': 'researcher', 'x-pai-groups': 'researchers,proj-team', 'x-pai-project': 'team', origin: 'https://dashboard.test', 'content-type': 'application/json', ...extra }, ...(json === undefined ? {} : { body: JSON.stringify(json) }) });
}

describe('browser credential and token route contracts', () => {
  it('creates/rotates/deletes SecureString references without values in GET, metadata or audit', async () => {
    const response = await POST(request('/api/credentials', 'POST', { name: 'HF', kind: 'hf', value: 'route-private-value' }));
    expect(response.status).toBe(201);
    const created = await response.json();
    expect(aws.ssm.mock.calls[0][0].input).toMatchObject({ Type: 'SecureString', Overwrite: false, Value: 'route-private-value' });
    const listing = await (await GET(request('/api/credentials'))).json();
    expect(listing).toMatchObject({ projectId: 'team', credentials: [{ id: created.id, status: 'READY' }] });
    expect(JSON.stringify(listing)).not.toContain('route-private-value');
    expect((await ROTATE(request(`/api/credentials/${created.id}/rotate`, 'POST', { value: 'rotated-private-value' }), { params: Promise.resolve({ id: created.id }) })).status).toBe(200);
    expect(JSON.stringify([...kv.items.values()])).not.toMatch(/route-private-value|rotated-private-value/);
    expect((await DELETE(request(`/api/credentials/${created.id}`, 'DELETE'), { params: Promise.resolve({ id: created.id }) })).status).toBe(200);
    expect((await (await GET(request('/api/credentials'))).json()).credentials).toEqual([]);
  });
  it('does not authorize another member to rotate a private credential', async () => {
    const created = await (await POST(request('/api/credentials', 'POST', { name: 'HF', kind: 'hf', value: 'secret' }))).json();
    const response = await ROTATE(request(`/api/credentials/${created.id}/rotate`, 'POST', { value: 'new' }, { 'x-pai-user': 'bob', 'x-pai-subject': 'sub-b' }), { params: Promise.resolve({ id: created.id }) });
    expect(response.status).toBe(403);
    expect(aws.ssm).toHaveBeenCalledTimes(1);
  });
  it('issues a no-store raw token once, lists only metadata, and revokes its digest', async () => {
    const response = await CREATE_TOKEN(request('/api/tokens', 'POST', { name: 'CLI', scopes: ['workflows:read'] }));
    expect(response.status).toBe(201); expect(response.headers.get('cache-control')).toBe('no-store');
    const { token, metadata } = await response.json();
    const listed = await (await LIST_TOKENS(request('/api/tokens'))).json();
    expect(listed.tokens[0].id).toBe(metadata.id);
    expect(JSON.stringify(listed)).not.toContain(token);
    expect(JSON.stringify(listed)).not.toContain('tokenHash');
    expect((await verifyApiToken(token, 'GET', '/api/me')).authMethod).toBe('token');
    expect((await REVOKE_TOKEN(request(`/api/tokens/${metadata.id}`, 'DELETE'), { params: Promise.resolve({ id: metadata.id }) })).status).toBe(200);
    await expect(verifyApiToken(token, 'GET', '/api/me')).rejects.toMatchObject({ status: 401 });
  });
  it('rejects management requests carrying bearer authentication', async () => {
    const headers = { authorization: 'Bearer pai_' + 'x'.repeat(43) };
    expect((await GET(request('/api/credentials', 'GET', undefined, headers))).status).toBe(403);
    expect((await LIST_TOKENS(request('/api/tokens', 'GET', undefined, headers))).status).toBe(403);
    expect(aws.ssm).not.toHaveBeenCalled();
    expect(aws.cognito).not.toHaveBeenCalled();
  });
});
