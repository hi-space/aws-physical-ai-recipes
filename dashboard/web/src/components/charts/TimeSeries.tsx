'use client';
import * as React from 'react';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

export interface Series { name: string; values: [number, number][] }
const PALETTE = ['#6ea8fe', '#34d399', '#fbbf24', '#f87171', '#c084fc', '#22d3ee', '#fb923c', '#a3e635', '#f472b6', '#94a3b8'];

/** Multi-series line chart over Prometheus-style [ts, value] pairs. */
export function TimeSeries({ series, height = 220, unit = '', yMax, formatter, className }: { series: Series[]; height?: number; unit?: string; yMax?: number; formatter?: (v: number) => string; className?: string }) {
  const data = React.useMemo(() => {
    const byTs = new Map<number, Record<string, number>>();
    for (const s of series) for (const [t, v] of s.values) byTs.set(t, { ...(byTs.get(t) ?? {}), [s.name]: v });
    return [...byTs.entries()].sort((a, b) => a[0] - b[0]).map(([t, v]) => ({ t, ...v }));
  }, [series]);
  const fmt = formatter ?? ((v: number) => `${Number.isInteger(v) ? v : v.toFixed(1)}${unit}`);
  if (!series.length || !data.length) return <div className="flex items-center justify-center text-xs text-fg-faint" style={{ height }}>no data in range</div>;
  return (
    <div className={className} style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="#232b3b" strokeDasharray="2 4" vertical={false} />
          <XAxis dataKey="t" tickFormatter={(t) => new Date(t * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })} stroke="#66718a" fontSize={10} tickLine={false} axisLine={false} minTickGap={40} />
          <YAxis stroke="#66718a" fontSize={10} tickLine={false} axisLine={false} width={44} domain={[0, yMax ?? 'auto']} tickFormatter={fmt} />
          <Tooltip contentStyle={{ background: '#111622', border: '1px solid #33405a', borderRadius: 6, fontSize: 11 }} labelFormatter={(t) => new Date(Number(t) * 1000).toLocaleString()} formatter={(v) => fmt(Number(v))} />
          {series.length > 1 && series.length <= 12 && <Legend wrapperStyle={{ fontSize: 11 }} />}
          {series.map((s, i) => (
            <Line key={s.name} type="monotone" dataKey={s.name} stroke={PALETTE[i % PALETTE.length]} dot={false} strokeWidth={1.5} isAnimationActive={false} connectNulls />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Convert an AMP range result into Series, naming each by the given labels. */
export function toSeries(result: { metric: Record<string, string>; values: [number, number][] }[] | undefined, labels: string[], fallback = 'value'): Series[] {
  return (result ?? []).map((r) => ({ name: labels.map((l) => r.metric[l]).filter(Boolean).join(' / ') || fallback, values: r.values }));
}
