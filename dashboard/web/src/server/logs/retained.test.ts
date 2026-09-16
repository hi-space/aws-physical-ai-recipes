import { expect, it, vi } from 'vitest';
import type { Pod } from '../k8s/resources';
import { retainedPodLogs } from './retained';
const session = { user: 'admin', subject: 'sub', email: '', role: 'admin' as const };
const original: Pod = { metadata: { name: 'legacy', namespace: 'team', uid: 'uid' }, spec: { containers: [{ name: 'main', image: 'image' }] },
  status: { phase: 'Running', containerStatuses: [{ name: 'main', ready: true, restartCount: 0 }] } };
function deps() {
  return { user: vi.fn(async () => ({ username: 'admin', subject: 'sub', enabled: true, groups: ['admins'], email: '' })),
    pod: vi.fn(async () => original), read: vi.fn(async (_path: string, _signal: AbortSignal) => new Response('same\nsame\n\nhttps://example.test/model\n')) };
}
it('preserves bounded retained bytes with explicit source/coverage and no archive claim', async () => {
  const d = deps();
  expect(await retainedPodLogs(session, 'team', 'legacy', new URL('https://app/api/logs'), new AbortController().signal, d))
    .toMatchObject({ source: 'kubernetes-retained', coverage: 'retained-only', redaction: 'unavailable', podUid: 'uid',
      lines: ['same', 'same', '', 'https://example.test/model', ''] });
  expect(d.read.mock.calls[0][0]).toContain('limitBytes=1048576');
});
it('rejects token/researcher access and discards a Pod replacement instead of guessing by name', async () => {
  const d = deps(), url = new URL('https://app/api/logs'), signal = new AbortController().signal;
  await expect(retainedPodLogs({ ...session, authMethod: 'token' }, 'team', 'legacy', url, signal, d)).rejects.toMatchObject({ status: 403 });
  await expect(retainedPodLogs({ ...session, role: 'researcher' }, 'team', 'legacy', url, signal, d)).rejects.toMatchObject({ status: 403 });
  expect(d.read).not.toHaveBeenCalled();
  d.pod.mockResolvedValueOnce(original).mockResolvedValueOnce({ ...original, metadata: { ...original.metadata, uid: 'replaced' } });
  await expect(retainedPodLogs(session, 'team', 'legacy', url, signal, d)).rejects.toMatchObject({ status: 409 });
});
