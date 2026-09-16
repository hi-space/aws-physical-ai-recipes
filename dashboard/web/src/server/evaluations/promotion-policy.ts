export interface EvaluationMetrics {
  kind: 'smoke' | 'open-loop' | 'simulation' | 'benchmark' | 'hardware';
  episodes: number;
  successes: number;
  latencyP95Ms?: number;
}

export interface PromotionPolicy {
  minimumEpisodes: number;
  minimumSuccessRate: number;
  maximumLatencyP95Ms?: number;
}

export interface PromotionDecision {
  status: 'pass' | 'fail' | 'review';
  reasons: string[];
}

/**
 * Decide whether an evaluated robot policy is ready for promotion.
 * A shape/finite-value smoke check is not evidence of task performance.
 * The caller records the exact model, dataset and evaluation provenance.
 */
export function evaluatePromotion(
  metrics: EvaluationMetrics,
  policy: PromotionPolicy,
): PromotionDecision {
  if (!Number.isInteger(policy.minimumEpisodes) || policy.minimumEpisodes < 1 ||
      !Number.isFinite(policy.minimumSuccessRate) || policy.minimumSuccessRate < 0 || policy.minimumSuccessRate > 1 ||
      (policy.maximumLatencyP95Ms !== undefined && (!Number.isFinite(policy.maximumLatencyP95Ms) || policy.maximumLatencyP95Ms <= 0))) {
    return { status: 'fail', reasons: ['승격 정책의 평가 횟수·성공률·지연시간 범위가 올바르지 않습니다.'] };
  }
  if (!Number.isInteger(metrics.episodes) || !Number.isInteger(metrics.successes) ||
      metrics.episodes < 0 || metrics.successes < 0 || metrics.successes > metrics.episodes ||
      (metrics.latencyP95Ms !== undefined && (!Number.isFinite(metrics.latencyP95Ms) || metrics.latencyP95Ms < 0))) {
    return { status: 'fail', reasons: ['평가 결과에 유효하지 않은 수치가 있습니다.'] };
  }
  if (!['simulation', 'hardware'].includes(metrics.kind)) return { status: 'review', reasons: ['로봇 작업 성능을 확인하는 시뮬레이션 또는 하드웨어 평가가 필요합니다.'] };
  if (metrics.episodes < policy.minimumEpisodes) return { status: 'review', reasons: [`최소 ${policy.minimumEpisodes}회 평가가 필요합니다.`] };
  const failures: string[] = [];
  if (metrics.successes / metrics.episodes < policy.minimumSuccessRate) failures.push('작업 성공률이 기준보다 낮습니다.');
  if (policy.maximumLatencyP95Ms !== undefined) {
    if (metrics.latencyP95Ms === undefined) return { status: 'review', reasons: ['p95 추론 지연시간 측정값이 필요합니다.', ...failures] };
    if (metrics.latencyP95Ms > policy.maximumLatencyP95Ms) failures.push('p95 추론 지연시간이 기준을 초과합니다.');
  }
  return failures.length ? { status: 'fail', reasons: failures } : { status: 'pass', reasons: ['설정한 평가 기준을 모두 통과했습니다.'] };
}
