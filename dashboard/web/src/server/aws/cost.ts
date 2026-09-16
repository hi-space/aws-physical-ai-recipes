import { GetCostAndUsageCommand } from '@aws-sdk/client-cost-explorer';
import { costExplorer } from './clients';

export async function last30DaysByService(): Promise<{ total: number; byService: { service: string; amount: number }[]; daily: { date: string; amount: number }[] }> {
  const end = new Date();
  const start = new Date(end.getTime() - 30 * 86400_000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const out = await costExplorer().send(
    new GetCostAndUsageCommand({
      TimePeriod: { Start: fmt(start), End: fmt(end) },
      Granularity: 'DAILY',
      Metrics: ['UnblendedCost'],
      GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
    }),
  );
  const byService = new Map<string, number>();
  const daily: { date: string; amount: number }[] = [];
  for (const r of out.ResultsByTime ?? []) {
    let day = 0;
    for (const g of r.Groups ?? []) {
      const amt = Number(g.Metrics?.UnblendedCost?.Amount ?? 0);
      const svc = g.Keys?.[0] ?? 'Other';
      byService.set(svc, (byService.get(svc) ?? 0) + amt);
      day += amt;
    }
    daily.push({ date: r.TimePeriod?.Start ?? '', amount: day });
  }
  const list = [...byService.entries()].map(([service, amount]) => ({ service, amount })).sort((a, b) => b.amount - a.amount);
  return { total: list.reduce((a, b) => a + b.amount, 0), byService: list.slice(0, 12), daily };
}
