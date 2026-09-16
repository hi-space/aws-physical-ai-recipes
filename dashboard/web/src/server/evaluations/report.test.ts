import { describe, expect, it } from 'vitest';
import { normalizeEvaluationReport } from './report';

export const reportFixture = (count = 20) => ({
  schemaVersion: 1, type: 'closed_loop', task: 'Workshop-SO101-Reach-MuJoCo-v0',
  seed: 2042, episodeCount: count, successCount: count, successRate: 1,
  timeoutCount: count, timeoutSeconds: 10,
  latencyMs: { p50: 2, p95: 5, p99: 8 }, checkpointDigest: 'a'.repeat(64),
  normalizationDigest: 'b'.repeat(64),
  simulator: { name: 'MuJoCo', version: '3.3.2', sceneSha256: 'c'.repeat(64) },
  videoUri: 'videos/episode-0000.mp4',
  episodes: Array.from({ length: count }, (_, index) => ({
    index, seed: 2042 + index, steps: 200, success: true, timeout: true,
    return: 1.25, finalDistance: 0.02, videoUri: `videos/episode-${String(index).padStart(4, '0')}.mp4`,
  })),
});

describe('published recipe evaluation reports', () => {
  it('normalizes real MuJoCo fields without treating a successful time-limit episode as failure', () => {
    expect(normalizeEvaluationReport(reportFixture())).toMatchObject({
      metrics: { kind: 'simulation', episodes: 20, successes: 20, latencyP95Ms: 5 },
      timeoutCount: 20, checkpointDigest: 'a'.repeat(64), seed: 2042,
    });
  });
  it('leaves absent latency absent for the existing policy to send to review', () => {
    const { latencyMs: _ignored, ...report } = reportFixture();
    expect(normalizeEvaluationReport(report).metrics.latencyP95Ms).toBeUndefined();
  });
  it.each([
    { successCount: 21 }, { successRate: 0.8 }, { episodeCount: 0 },
    { checkpointDigest: 'made-up' }, { latencyMs: { p50: 10, p95: 2, p99: 1 } },
    { latencyMs: { p95: Number.NaN } }, { status: 'failed' }, { status: 'running' },
    { episodes: [{ ...reportFixture(1).episodes[0], return: Infinity }] },
    { requestedEpisodeCount: 21 }, { videoUri: '../other-project/video.mp4' },
  ])('rejects invalid or incomplete runtime evidence: %j', (change) => {
    expect(() => normalizeEvaluationReport({ ...reportFixture(), ...change })).toThrow();
  });
  it('rejects duplicate episodes, mismatched success totals and manual metric objects', () => {
    const valid = reportFixture();
    expect(() => normalizeEvaluationReport({ ...valid, episodes: valid.episodes.map(e => ({ ...e, index: 0 })) })).toThrow();
    expect(() => normalizeEvaluationReport({ ...valid, episodes: valid.episodes.map(e => ({ ...e, success: false })) })).toThrow();
    expect(() => normalizeEvaluationReport({ kind: 'simulation', episodes: 20, successes: 20 })).toThrow();
  });
});
