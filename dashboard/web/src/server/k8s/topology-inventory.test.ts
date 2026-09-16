import { beforeEach, expect, it, vi } from 'vitest';
const request = vi.hoisted(() => vi.fn());
vi.mock('./client', () => ({ k8sJson: request, k8sGetOrNull: vi.fn(), k8sRequest: vi.fn(), assertWritableNamespace: vi.fn(), K8sError: class extends Error {} }));
import { listNodes } from './resources';
beforeEach(() => request.mockReset());
it('reads all registered Nodes without losing the exact pool selector between pages', async () => {
  request.mockResolvedValueOnce({ items: [{ metadata: { name: 'first' } }], metadata: { continue: 'opaque/+/=' } })
    .mockResolvedValueOnce({ items: [{ metadata: { name: 'last' } }] });
  const nodes = await listNodes('pai.aws/pool=training,node.kubernetes.io/instance-type=ml.p5.48xlarge');
  expect(nodes.map(n => n.metadata.name)).toEqual(['first', 'last']);
  const calls = request.mock.calls.map(([url]) => new URL(url, 'http://local'));
  expect(calls.every(u => u.pathname === '/api/v1/nodes' && u.searchParams.get('limit') === '500')).toBe(true);
  expect(calls.map(u => u.searchParams.get('labelSelector'))).toEqual(Array(2).fill('pai.aws/pool=training,node.kubernetes.io/instance-type=ml.p5.48xlarge'));
  expect(calls[1].searchParams.get('continue')).toBe('opaque/+/=');
});
it('does not present a repeated continuation page as a complete inventory', async () => {
  request.mockResolvedValue({ items: [], metadata: { continue: 'loop' } });
  await expect(listNodes()).rejects.toThrow(/repeated continuation/);
});
