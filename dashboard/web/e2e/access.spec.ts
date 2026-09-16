import { request } from '@playwright/test';
import { test, expect } from './researcher-helpers/fixture';
test.use({ screenshot: 'off', trace: 'off', video: 'off' });

test('project API token uses live authorization, cannot elevate, and is revoked immediately', async ({ researcher }, info) => {
  const created = await researcher.api<{ token: string; metadata: { id: string } }>('POST', '/api/tokens', {
    name: `validation-${researcher.tag}`, scopes: ['workflows:read', 'datasets:read', 'metrics:read'], expiresInDays: 1,
  }, [201]);
  const client = await request.newContext({ ignoreHTTPSErrors: false, extraHTTPHeaders: { authorization: `Bearer ${created.token}` } });
  let revoked = false;
  async function call(method: string, path: string, data?: unknown) {
    try { return await client.fetch(researcher.origin + path, { method, data, maxRedirects: 0, timeout: 30_000 }); }
    catch { throw new Error('Token API transport failed (credentials omitted)'); }
  }
  try {
    const me = await call('GET', '/api/v1/me');
    expect(me.status()).toBe(200);
    const identity = await me.json();
    expect(identity).toMatchObject({ authMethod: 'token', role: 'researcher', tokenProjectId: researcher.project.id, subject: researcher.principal.subject });
    await me.dispose();
    const workflow = await call('POST', '/api/v1/workflows', { yaml: 'not evaluated because scope denies this mutation' });
    expect([401, 403]).toContain(workflow.status()); await workflow.dispose();
    const admin = await call('GET', '/api/v1/admin/users');
    expect([401, 403]).toContain(admin.status()); await admin.dispose();
    const metrics = await call('POST', '/api/v1/metrics/query', { queries: [{ id: 'foreign', metric: 'pod_cpu', params: { namespace: 'hyperpod-ns-team-b' } }] });
    expect(metrics.status()).toBe(403); await metrics.dispose();
    await researcher.api('DELETE', `/api/tokens/${created.metadata.id}`); revoked = true;
    const after = await call('GET', '/api/v1/me');
    expect(after.status()).toBe(401); await after.dispose();
    await info.attach('token-authorization', { contentType: 'application/json', body: Buffer.from(JSON.stringify({ project: researcher.project.id, delegatedRole: 'researcher', writeDenied: true, adminDenied: true, foreignNamespaceDenied: true, revocationObserved: true })) });
  } finally {
    if (!revoked) await researcher.api('DELETE', `/api/tokens/${created.metadata.id}`);
    await client.dispose();
  }
});
