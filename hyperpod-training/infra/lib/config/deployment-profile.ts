/**
 * 배포 프로필
 *
 * - personal        : 개인 계정(기본). GPU 워크스테이션(g6e/g6), 전 모듈 진행.
 * - workshop-studio : Workshop Studio 이벤트 계정. us-east-1/us-west-2만 허용. head 노드는
 *                     personal과 같은 ml.m5.xlarge (실측 cluster usage 쿼터: m5.xlarge 10, g5.* 0 —
 *                     cluster-config.ts HEAD_INSTANCE_BY_PROFILE 주석 참고).
 */
export type DeploymentProfile = 'personal' | 'workshop-studio';

export const DEPLOYMENT_PROFILES: readonly DeploymentProfile[] = ['personal', 'workshop-studio'];

/** `-c profile=` 값을 검증한다. 미지정이면 personal. */
export function parseDeploymentProfile(value: unknown): DeploymentProfile {
  const v = (value ?? 'personal') as string;
  if (!DEPLOYMENT_PROFILES.includes(v as DeploymentProfile)) {
    throw new Error(`profile은 'personal' 또는 'workshop-studio' 여야 합니다: '${v}'`);
  }
  return v as DeploymentProfile;
}
