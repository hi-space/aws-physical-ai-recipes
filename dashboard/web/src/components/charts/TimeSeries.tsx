'use client';
import * as React from 'react';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useT } from '@/lib/i18n';

export interface Series { name: string; values: [number, number][] }
const PALETTE = ['#6ea8fe', '#34d399', '#fbbf24', '#f87171', '#c084fc', '#22d3ee', '#fb923c', '#a3e635', '#f472b6', '#94a3b8'];

/** Accepts epoch seconds by default, or numeric training steps for experiment comparison. */
export function TimeSeries({ series, height = 220, unit = '', yMax, formatter, className, xAxis = 'time' }: { series: Series[]; height?: number; unit?: string; yMax?: number; formatter?: (v: number) => string; className?: string; xAxis?: 'time' | 'step' }) {
  const t = useT('metrics');
  const data = React.useMemo(() => {
    const byTs = new Map<number, Record<string, number>>();
    // Use stable internal keys so dots in metric/run names are not interpreted as object paths.
    series.forEach((s, i) => {
      for (const [t, v] of s.values) {
        if (Number.isFinite(t) && Number.isFinite(v)) byTs.set(t, { ...(byTs.get(t) ?? {}), [`series${i}`]: v });
      }
    });
    return [...byTs.entries()].sort((a, b) => a[0] - b[0]).map(([t, v]) => ({ t, ...v }));
  }, [series]);
  const fmt = formatter ?? ((v: number) => `${Number.isInteger(v) ? v : v.toFixed(1)}${unit}`);
  if (!series.length || !data.length) return <div className="flex items-center justify-center text-xs text-fg-faint" style={{ height }}>{t('noDataInRange')}</div>;
  return (
    <div className={className} style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="#232b3b" strokeDasharray="2 4" vertical={false} />
          <XAxis dataKey="t" type="number" domain={['dataMin', 'dataMax']} tickFormatter={(t) => xAxis === 'step' ? Number(t).toLocaleString() : new Date(t * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })} stroke="#66718a" fontSize={10} tickLine={false} axisLine={false} minTickGap={40} />
          <YAxis stroke="#66718a" fontSize={10} tickLine={false} axisLine={false} width={44} domain={[xAxis === 'step' ? 'auto' : 0, yMax ?? 'auto']} tickFormatter={fmt} />
          <Tooltip contentStyle={{ background: '#111622', border: '1px solid #33405a', borderRadius: 6, fontSize: 11 }} labelFormatter={(t) => xAxis === 'step' ? `step ${Number(t).toLocaleString()}` : new Date(Number(t) * 1000).toLocaleString()} formatter={(v) => fmt(Number(v))} />
          {series.length > 1 && series.length <= 12 && <Legend wrapperStyle={{ fontSize: 11 }} />}
          {series.map((s, i) => (
            <Line key={`${i}-${s.name}`} name={s.name} type="linear" dataKey={`series${i}`} stroke={PALETTE[i % PALETTE.length]} dot={s.values.length === 1} strokeWidth={1.5} isAnimationActive={false} connectNulls />
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
