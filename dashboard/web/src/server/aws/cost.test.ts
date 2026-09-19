import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cachedAccountCost, last30DaysByService, resetAccountCostCache } from './cost';
const send = vi.hoisted(() => vi.fn());
vi.mock('./clients', () => ({ costExplorer: () => ({ send }) }));
beforeEach(() => send.mockReset());
it('aggregates all cost pages and exposes account scope, estimated basis, and all services', async () => {
  send.mockResolvedValueOnce({ NextPageToken: 'next', ResultsByTime: [{ TimePeriod: { Start: '2026-09-15' }, Estimated: true, Groups: [{ Keys: ['EC2'], Metrics: { UnblendedCost: { Amount: '2', Unit: 'USD' } } }] }] })
    .mockResolvedValueOnce({ ResultsByTime: [{ TimePeriod: { Start: '2026-09-15' }, Groups: [{ Keys: ['S3'], Metrics: { UnblendedCost: { Amount: '3', Unit: 'USD' } } }] }] });
  const result = await last30DaysByService();
  expect(result.total).toBe(5);
  expect(result.daily).toEqual([{ date: '2026-09-15', amount: 5 }]);
  expect(result.byService).toEqual([{ service: 'S3', amount: 3 }, { service: 'EC2', amount: 2 }]);
  expect(result).toMatchObject({
    scope: 'account',
    currency: 'USD',
    estimated: true,
    start: expect.any(String),
    end: expect.any(String),
    fetchedAt: expect.any(String),
  });
  expect(send.mock.calls[1][0].input.NextPageToken).toBe('next');
});
it('rejects repeated pagination tokens rather than returning partial cost as a complete total', async () => {
  send.mockResolvedValue({ NextPageToken: 'same', ResultsByTime: [] });
  await expect(last30DaysByService()).rejects.toThrow(/incomplete/);
});

describe('cachedAccountCost', () => {
  beforeEach(() => resetAccountCostCache());
  const page = { ResultsByTime: [{ TimePeriod: { Start: '2026-09-15' }, Groups: [{ Keys: ['EC2'], Metrics: { UnblendedCost: { Amount: '1', Unit: 'USD' } } }] }] };
  it('calls Cost Explorer once within the hour and again after it', async () => {
    let now = 1_000_000;
    send.mockResolvedValue(page);
    await cachedAccountCost(() => now);
    await cachedAccountCost(() => now + 3_599_000);
    expect(send).toHaveBeenCalledTimes(1);
    await cachedAccountCost(() => now + 3_600_001);
    expect(send).toHaveBeenCalledTimes(2);
  });
  it('returns the previous value marked stale when a refresh fails', async () => {
    send.mockResolvedValueOnce(page);
    const first = await cachedAccountCost(() => 0);
    send.mockRejectedValueOnce(new Error('throttled'));
    const second = await cachedAccountCost(() => 3_600_001);
    expect(second.total).toBe(first.total);
    expect(second.stale).toBe(true);
  });
  it('rethrows when there is no cached value to fall back to', async () => {
    send.mockRejectedValueOnce(new Error('throttled'));
    await expect(cachedAccountCost(() => 0)).rejects.toThrow('throttled');
  });
});
