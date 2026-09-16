import { describe, expect, it } from 'vitest';
import { MemoryKV } from './dynamo';
import { Repo } from './repo';

describe('Repo (memory)', () => {
  it('stores and lists workflows newest first', async () => {
    const r = new Repo(new MemoryKV());
    const base = { namespace: 'rl', owner: 'u', status: 'PENDING' as const, spec: {} as never, specYaml: '', vars: {}, updatedAt: 'x', taskCount: 0, succeededCount: 0, failedCount: 0 };
    await r.putWorkflow({ ...base, id: 'a', name: 'a', createdAt: '2026-01-01T00:00:00Z' });
    await r.putWorkflow({ ...base, id: 'b', name: 'b', createdAt: '2026-01-02T00:00:00Z' });
    expect((await r.listWorkflows()).map((w) => w.id)).toEqual(['b', 'a']);
    expect((await r.getWorkflow('a'))?.name).toBe('a');
    expect((await r.getWorkflow('a')) as never).not.toHaveProperty('pk');
  });
  it('orders dataset versions numerically', async () => {
    const r = new Repo(new MemoryKV());
    for (const v of [1, 2, 10]) await r.putVersion({ dataset: 'd', version: v, uri: 's3://b/p', tags: [], createdAt: 'x', createdBy: 'u' });
    expect((await r.listVersions('d')).map((v) => v.version)).toEqual([10, 2, 1]);
  });
  it('lease is exclusive until expiry', async () => {
    const r = new Repo(new MemoryKV());
    expect(await r.acquireLease('CONTROLLER', 'a', 30)).toBe(true);
    expect(await r.acquireLease('CONTROLLER', 'b', 30)).toBe(false);
    expect(await r.acquireLease('CONTROLLER', 'a', 30)).toBe(true);
  });
  it('audit entries are newest first', async () => {
    const r = new Repo(new MemoryKV());
    await r.audit({ ts: '2026-01-01T00:00:00Z', actor: 'a', role: 'admin', action: 'x', result: 'ok' });
    await r.audit({ ts: '2026-01-02T00:00:00Z', actor: 'a', role: 'admin', action: 'y', result: 'ok' });
    expect((await r.listAudit()).map((e) => e.action)).toEqual(['y', 'x']);
  });
});
