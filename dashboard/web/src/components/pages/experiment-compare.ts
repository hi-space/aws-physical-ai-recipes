import type { Series } from '@/components/charts/TimeSeries';

export interface MetricPoint { step: number; value: number; timestamp: number }
export interface RunMetric extends MetricPoint { key: string }
export interface CompareRun {
  info: { run_id: string; run_name?: string };
  data: { metrics?: RunMetric[]; params?: { key: string; value: string }[] };
}
export type MetricHistory = Record<string, MetricPoint[]>;

export function latestMetrics(metrics: RunMetric[] = []): Record<string, RunMetric> {
  const latest: Record<string, RunMetric> = Object.create(null);
  for (const metric of metrics) {
    const previous = latest[metric.key];
    if (!previous || metric.step > previous.step || (metric.step === previous.step && metric.timestamp > previous.timestamp)) {
      latest[metric.key] = metric;
    }
  }
  return latest;
}

export function compareParams(runs: CompareRun[]) {
  const params = runs.map((run) => new Map((run.data.params ?? []).map((p) => [p.key, p.value])));
  const keys = [...new Set(params.flatMap((p) => [...p.keys()]))].sort();
  return keys.map((key) => {
    const values = params.map((p) => p.get(key) ?? null);
    return { key, values, differs: new Set(values).size > 1 };
  });
}

export function metricSeries(runs: CompareRun[], histories: Record<string, MetricHistory | undefined>, key: string): Series[] {
  return runs.map((run) => {
    const byStep = new Map<number, MetricPoint>();
    for (const point of histories[run.info.run_id]?.[key] ?? []) {
      if (!Number.isFinite(point.step) || !Number.isFinite(point.value)) continue;
      const previous = byStep.get(point.step);
      if (!previous || point.timestamp > previous.timestamp) byStep.set(point.step, point);
    }
    return {
      name: run.info.run_name ? `${run.info.run_name} (${run.info.run_id})` : run.info.run_id,
      values: [...byStep.values()].sort((a, b) => a.step - b.step).map((p): [number, number] => [p.step, p.value]),
    };
  });
}
