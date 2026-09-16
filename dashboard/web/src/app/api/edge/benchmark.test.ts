import { describe, expect, it } from 'vitest';
import { parseBenchmark } from '@/server/evaluations/benchmark';
const row = { mode: 'pytorch', avg_ms: 20, p50_ms: 18, p95_ms: 30, p99_ms: 40, std_ms: 3, hz: 50, iterations: 50 };
describe('workshop benchmark evidence', () => {
  it('reads the actual workshop field names and final JSON from logs', () => {
    expect(parseBenchmark(`Warmup complete\n${JSON.stringify([row, { mode: 'trt_dit_action_head', status: 'skipped', reason: 'engine not found' }], null, 2)}\n=== Benchmark Complete ===`).results)
      .toMatchObject([{ status: 'measured', avg_ms: 20, p95_ms: 30 }, { status: 'skipped', reason: 'engine not found' }]);
  });
  it.each([{ p95_ms: Infinity }, { p99_ms: 1 }, { hz: 1 }, { iterations: 0 }, { std_ms: -1 }, { status: 'failed' }])('rejects invalid or contradictory measurements %j', patch => {
    expect(() => parseBenchmark([{ ...row, ...patch }])).toThrow();
  });
  it('preserves the identity envelope without inventing missing engine/platform data', () => {
    expect(parseBenchmark([row]).envelope).toBeUndefined();
    expect(parseBenchmark({ schemaVersion: 1, modelId: 'm', results: [row] }).envelope?.modelId).toBe('m');
  });
});
