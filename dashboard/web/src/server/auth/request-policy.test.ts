import { describe, expect, it } from 'vitest';
import { assertSameOrigin } from './request-policy';
import { authorizeApiResource } from './request-policy';
import { NextRequest } from 'next/server';
import { Repo, setRepoForTests } from '../store/repo';
import { MemoryKV } from '../store/dynamo';
describe('browser mutation origin', () => {
  it('accepts same-origin changes and rejects sibling sites and missing origins', () => {
    const origin = 'https://physical-ai.example.com';
    expect(() => assertSameOrigin(new Request(origin, { method: 'POST', headers: { origin, 'sec-fetch-site': 'same-origin' } }), origin)).not.toThrow();
    expect(() => assertSameOrigin(new Request(origin, { method: 'POST', headers: { origin: 'https://job.apps.example.com' } }), origin)).toThrow();
    expect(() => assertSameOrigin(new Request(origin, { method: 'POST' }), origin)).toThrow();
    expect(() => assertSameOrigin(new Request(origin), origin)).not.toThrow();
  });
});
it('requires project write permission for retry even when the user is a global researcher', async () => {
  const repo = new Repo(new MemoryKV()); setRepoForTests(repo);
  await repo.kv.put({ pk: 'PROJECT#p', sk: 'META', id: 'p', gsi1pk: 'TYPE#PROJECT', gsi1sk: 'p' });
  await repo.kv.put({ pk: 'WF#w', sk: 'META', id: 'w', owner: 'bob', projectId: 'p' });
  // session.role reflects the platform role header; project role composition reads session.groups
  // independently, so a proj-p group without a platform researchers/admins group composes to viewer.
  const principal = { user: 'alice', subject: 'alice', email: '', role: 'researcher' as const, groups: ['proj-p'] };
  await expect(authorizeApiResource(new NextRequest('https://app.example/api/workflows/w'), principal)).resolves.toBeUndefined();
  await expect(authorizeApiResource(new NextRequest('https://app.example/api/workflows/w/retry', { method: 'POST' }), principal)).rejects.toThrow(/researcher/);
});
