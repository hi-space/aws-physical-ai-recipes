import { describe, expect, it } from 'vitest';
import { evaluatePromotion } from './promotion-policy';
const policy = { minimumEpisodes: 20, minimumSuccessRate: 0.8, maximumLatencyP95Ms: 100 };
describe('research evaluation gates', () => {
  it('never treats a smoke check as robot performance evidence', () => {
    expect(evaluatePromotion({ kind: 'smoke', episodes: 20, successes: 20, latencyP95Ms: 1 }, policy).status).toBe('review');
  });
  it('requires enough real simulation trials and the requested latency evidence', () => {
    expect(evaluatePromotion({ kind: 'simulation', episodes: 5, successes: 5, latencyP95Ms: 10 }, policy).status).toBe('review');
    expect(evaluatePromotion({ kind: 'simulation', episodes: 20, successes: 20 }, policy).status).toBe('review');
  });
  it('passes only evidence meeting all configured thresholds', () => {
    expect(evaluatePromotion({ kind: 'simulation', episodes: 20, successes: 16, latencyP95Ms: 90 }, policy).status).toBe('pass');
    expect(evaluatePromotion({ kind: 'hardware', episodes: 20, successes: 15, latencyP95Ms: 90 }, policy).status).toBe('fail');
    expect(evaluatePromotion({ kind: 'simulation', episodes: 20, successes: 20, latencyP95Ms: 101 }, policy).status).toBe('fail');
  });
  it('rejects invalid measurements and policies rather than promoting them', () => {
    expect(evaluatePromotion({ kind: 'simulation', episodes: 20, successes: 21, latencyP95Ms: 10 }, policy).status).toBe('fail');
    expect(evaluatePromotion({ kind: 'simulation', episodes: 20, successes: 20, latencyP95Ms: NaN }, policy).status).toBe('fail');
    expect(evaluatePromotion({ kind: 'simulation', episodes: 20, successes: 20 }, { minimumEpisodes: 0, minimumSuccessRate: -1 }).status).toBe('fail');
  });
});
