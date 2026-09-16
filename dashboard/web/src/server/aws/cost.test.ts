import { beforeEach, expect, it, vi } from 'vitest';
import { last30DaysByService } from './cost';
const send = vi.hoisted(() => vi.fn());
vi.mock('./clients', () => ({ costExplorer: () => ({ send }) }));
beforeEach(() => send.mockReset());
it('aggregates all cost pages and exposes account scope and observed/estimated basis', async () => {
  send.mockResolvedValueOnce({ NextPageToken: 'next', ResultsByTime: [{ TimePeriod: { Start: '2026-09-15' }, Estimated: true, Groups: [{ Keys: ['EC2'], Metrics: { UnblendedCost: { Amount: '2', Unit: 'USD' } } }] }] })
    .mockResolvedValueOnce({ ResultsByTime: [{ TimePeriod: { Start: '2026-09-15' }, Groups: [{ Keys: ['S3'], Metrics: { UnblendedCost: { Amount: '3', Unit: 'USD' } } }] }] });
  const result = await last30DaysByService();
  expect(result.total).toBe(5); expect(result.daily).toEqual([{ date: '2026-09-15', amount: 5 }]);
  expect(result).toMatchObject({ scope: 'account', currency: 'USD', estimated: true });
  expect(send.mock.calls[1][0].input.NextPageToken).toBe('next');
});
it('rejects repeated pagination tokens rather than returning partial cost as a complete total', async () => {
  send.mockResolvedValue({ NextPageToken: 'same', ResultsByTime: [] });
  await expect(last30DaysByService()).rejects.toThrow(/incomplete/);
});
