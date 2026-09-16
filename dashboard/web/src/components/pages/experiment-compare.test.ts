import { describe, expect, it } from 'vitest';
import { compareParams, latestMetrics, metricSeries, type CompareRun } from './experiment-compare';

const runs: CompareRun[] = [
  { info: { run_id: 'a', run_name: 'train' }, data: { params: [{ key: 'seed', value: '0' }, { key: 'lr', value: '0.01' }] } },
  { info: { run_id: 'b', run_name: 'train' }, data: { params: [{ key: 'seed', value: '1' }] } },
];

describe('experiment comparison', () => {
  it('compares the union of parameters and distinguishes missing from zero', () => {
    expect(compareParams(runs)).toEqual([
      { key: 'lr', values: ['0.01', null], differs: true },
      { key: 'seed', values: ['0', '1'], differs: true },
    ]);
  });

  it('selects the latest step then timestamp, never comparing a step to a metric value', () => {
    expect(latestMetrics([
      { key: 'reward', step: 1, value: 999, timestamp: 1 },
      { key: 'reward', step: 3, value: 0, timestamp: 2 },
      { key: 'reward', step: 2, value: 50, timestamp: 4 },
      { key: 'reward', step: 3, value: -1, timestamp: 3 },
    ])).toEqual({ reward: { key: 'reward', step: 3, value: -1, timestamp: 3 } });
  });

  it('aligns actual steps, deduplicates by timestamp, and retains a missing run as an empty series', () => {
    const series = metricSeries(runs, {
      a: { loss: [
        { step: 20, value: 0, timestamp: 3 },
        { step: 5, value: 7, timestamp: 1 },
        { step: 5, value: 6, timestamp: 2 },
        { step: 30, value: NaN, timestamp: 4 },
      ] },
      b: {},
    }, 'loss');
    expect(series).toEqual([
      { name: 'train (a)', values: [[5, 6], [20, 0]] },
      { name: 'train (b)', values: [] },
    ]);
  });

  it('keeps two runs with the same display name on their own recorded step coordinates', () => {
    expect(metricSeries(runs, {
      a: { reward: [{ step: 100, value: -2, timestamp: 1000 }, { step: 200, value: 0, timestamp: 2000 }] },
      b: { reward: [{ step: 50, value: -8, timestamp: 3000 }, { step: 150, value: 1, timestamp: 4000 }] },
    }, 'reward')).toEqual([
      { name: 'train (a)', values: [[100, -2], [200, 0]] },
      { name: 'train (b)', values: [[50, -8], [150, 1]] },
    ]);
  });
});
