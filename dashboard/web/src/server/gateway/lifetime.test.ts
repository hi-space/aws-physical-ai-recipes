import { afterEach, expect, it, vi } from 'vitest';
import { Repo } from '../store/repo';
import { MemoryKV } from '../store/dynamo';
import { issueLaunchTicket, consumeTicket } from './auth';
import { resolveRoute } from './routing';
import { guardConnection } from './lifetime';
import type { GatewaySession } from './types';

afterEach(() => vi.useRealTimers());
it('fails closed when an active connection authorization check never completes', async () => {
  vi.useFakeTimers();
  const repo = new Repo(new MemoryKV());
  const session: GatewaySession = { id: 'hung', kind: 'jupyter', namespace: 'research', podName: 'pod',
    port: 8888, ownerSubject: 'sub', expiresAt: new Date(Date.now() + 60_000).toISOString() };
  await repo.kv.put({ pk: 'SESS#hung', sk: 'META', ...session });
  const launch = await issueLaunchTicket(session, { subject: 'sub' }, { repo });
  const route = resolveRoute({ host: launch.host, path: '/' }, { repo });
  const { cookie } = await consumeTicket(launch.ticket, route, { repo });
  const controller = new AbortController();
  const cleanup = guardConnection(session, cookie.split(';')[0], route, controller, { repo, recheckMs: 20 });
  repo.kv.get = () => new Promise(() => undefined);
  await vi.advanceTimersByTimeAsync(5_021);
  expect(controller.signal.aborted).toBe(true);
  cleanup();
  expect(vi.getTimerCount()).toBe(0);
});
