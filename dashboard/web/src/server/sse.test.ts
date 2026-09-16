import { afterEach, expect, it, vi } from 'vitest';
import { sse } from './api';
afterEach(() => vi.useRealTimers());
it('keeps a quiet stream alive for a minute and cancels its upstream reader', async () => {
  vi.useFakeTimers();
  let release!: () => void;
  let finished = false;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  async function* source() {
    try { yield { event: 'meta', data: { pod: 'own-pod' } }; await waiting; }
    finally { finished = true; }
  }
  const cancel = vi.fn(async () => release());
  const reader = sse(source(), undefined, cancel).body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: meta');
  await vi.advanceTimersByTimeAsync(60_000);
  for (let index = 0; index < 4; index++) expect(new TextDecoder().decode((await reader.read()).value)).toBe(': heartbeat\n\n');
  await reader.cancel();
  await Promise.resolve(); await Promise.resolve();
  expect(cancel).toHaveBeenCalledOnce();
  expect(finished).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
