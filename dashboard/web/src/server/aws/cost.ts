import { GetCostAndUsageCommand } from '@aws-sdk/client-cost-explorer';
import { costExplorer } from './clients';

export interface AccountCost {
  total: number; byService: { service: string; amount: number }[]; daily: { date: string; amount: number }[];
  currency?: 'USD'; observedAt?: string; period?: { start: string; end: string };
  source?: 'AWS Cost Explorer / UnblendedCost'; scope?: 'account'; estimated?: boolean;
}
export async function last30DaysByService(): Promise<AccountCost> {
  const end = new Date();
  const start = new Date(end.getTime() - 30 * 86400_000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const byService = new Map<string, number>(), days = new Map<string, number>();
  const tokens = new Set<string>(); let token: string | undefined, estimated = false;
  do {
    const out = await costExplorer().send(new GetCostAndUsageCommand({
      TimePeriod: { Start: fmt(start), End: fmt(end) },
      Granularity: 'DAILY',
      Metrics: ['UnblendedCost'],
      GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
      NextPageToken: token,
    }));
    for (const r of out.ResultsByTime ?? []) {
    estimated ||= r.Estimated === true;
    let day = 0;
    for (const g of r.Groups ?? []) {
      const amt = Number(g.Metrics?.UnblendedCost?.Amount);
      if (!Number.isFinite(amt) || g.Metrics?.UnblendedCost?.Unit !== 'USD') throw new Error('Cost Explorer returned an unknown amount or currency');
      const svc = g.Keys?.[0] ?? 'Other';
      byService.set(svc, (byService.get(svc) ?? 0) + amt);
      day += amt;
    }
    const date = r.TimePeriod?.Start;
    if (!date) throw new Error('Cost Explorer returned an unknown billing date');
    days.set(date, (days.get(date) ?? 0) + day);
    }
    token = out.NextPageToken;
    if (token && (tokens.has(token) || tokens.size >= 100)) throw new Error('Cost Explorer pagination is incomplete');
    if (token) tokens.add(token);
  } while (token);
  const daily = [...days].sort(([a], [b]) => a.localeCompare(b)).map(([date, amount]) => ({ date, amount }));
  const list = [...byService.entries()].map(([service, amount]) => ({ service, amount })).sort((a, b) => b.amount - a.amount);
  return { total: list.reduce((a, b) => a + b.amount, 0), byService: list.slice(0, 12), daily,
    currency: 'USD' as const, observedAt: end.toISOString(), period: { start: fmt(start), end: fmt(end) },
    source: 'AWS Cost Explorer / UnblendedCost' as const, scope: 'account' as const, estimated };
}
