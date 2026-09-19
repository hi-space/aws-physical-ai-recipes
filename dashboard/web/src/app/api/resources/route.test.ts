import { describe, expect, it, vi } from 'vitest';
const list = vi.hoisted(() => vi.fn(async () => ({ tag: { key: 'PhysicalAI', value: 'true' }, fetchedAt: 't', region: 'us-east-1', accountId: '1', groups: [] })));
vi.mock('@/server/aws/tagged-resources', () => ({ listTaggedResources: list }));
vi.mock('@/server/api', () => ({ route: (_role: string, handler: (ctx: unknown) => Promise<unknown>) => async () => Response.json(await handler({})) }));
describe('GET /api/resources', () => {
  it('returns the tagged resource listing', async () => {
    const { GET } = await import('./route');
    const res = await GET(new Request('http://x/api/resources') as never, { params: Promise.resolve({}) } as never);
    expect(await res.json()).toMatchObject({ tag: { key: 'PhysicalAI' }, groups: [] });
    expect(list).toHaveBeenCalledTimes(1);
  });
});
