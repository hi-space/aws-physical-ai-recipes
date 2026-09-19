import { describe, expect, it, vi } from 'vitest';
import type { Pod } from '@/server/k8s/resources';
const mocks = vi.hoisted(() => ({ getPod: vi.fn(), podLogs: vi.fn(async () => '2026-09-19T00:00:00Z k=V4LUE\n'), secrets: vi.fn(async () => ['V4LUE']), access: vi.fn(async () => undefined) }));
vi.mock('@/server/k8s/resources', () => ({ getPod: mocks.getPod, podLogs: mocks.podLogs, streamPodLogs: vi.fn(), listPods: vi.fn() }));
vi.mock('@/server/workflow-adapters/log-secrets', () => ({ injectedLogSecrets: mocks.secrets }));
vi.mock('@/server/auth/projects', () => ({ assertNamespaceAccess: mocks.access }));
vi.mock('@/server/store/repo', () => ({ getRepo: () => ({ getWorkflow: async () => ({ id: 'w1', namespace: 'team' }), listTasks: async () => [{ name: 'train', attempts: 1 }] }) }));
vi.mock('@/server/api', () => ({ route: (_role: string, handler: (ctx: unknown) => Promise<unknown>) => async (req: Request, ctx: { params: Promise<Record<string, string>> }) => {
  try { const r = await handler({ req, params: await ctx.params, session: { user: 'u', subject: 's', role: 'researcher', authMethod: 'alb' } }); return r instanceof Response ? r : Response.json(r); }
  catch (e) { return Response.json({ error: String(e) }, { status: (e as { status?: number }).status ?? 500 }); } } }));
const managed: Pod = { metadata: { name: 'p', namespace: 'team', uid: 'u1', labels: { 'pai.aws/workflow-id': 'w1', 'pai.aws/task': 'train', 'pai.aws/attempt': '1' } }, spec: { containers: [{ name: 'main' }] } as Pod['spec'], status: { phase: 'Running' } };
const call = async (query = '') => { const { GET } = await import('./route'); return GET(new Request(`http://x/api/k8s/pods/team/p/logs?${query}`) as never, { params: Promise.resolve({ ns: 'team', name: 'p' }) }); };

describe('pod logs route', () => {
  it('returns pod-gone for a missing pod after checking namespace access', async () => {
    mocks.getPod.mockResolvedValueOnce(null);
    expect(await (await call()).json()).toMatchObject({ source: 'none', reason: 'pod-gone' });
    expect(mocks.access).toHaveBeenCalledWith(expect.anything(), 'team');
  });
  it('redacts dashboard-managed pods using the attempt secret', async () => {
    mocks.getPod.mockResolvedValue(managed);
    expect(await (await call('tail=10')).json()).toMatchObject({ source: 'kubernetes', redaction: 'applied', lines: [{ text: 'k=[REDACTED]' }] });
  });
  it('refuses non-admin reads when redaction cannot be verified', async () => {
    mocks.getPod.mockResolvedValue(managed); mocks.secrets.mockRejectedValueOnce(new Error('unverified'));
    const res = await call();
    expect(res.status).toBe(403);
  });
  it('serves unmanaged pods without redaction', async () => {
    mocks.getPod.mockResolvedValue({ ...managed, metadata: { name: 'p', namespace: 'team', uid: 'u2', labels: {} } });
    expect(await (await call()).json()).toMatchObject({ redaction: 'none', lines: [{ text: 'k=V4LUE' }] });
  });
  it('rejects a malformed since parameter', async () => {
    mocks.getPod.mockResolvedValue(managed);
    const res = await call('since=not-a-time');
    expect(res.status).toBe(400);
  });
});
