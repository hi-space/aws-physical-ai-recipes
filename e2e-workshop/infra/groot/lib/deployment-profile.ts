/**
 * 배포 프로필
 *
 * - personal        : 개인 계정(기본).
 * - workshop-studio : Workshop Studio 이벤트 계정. CPU 워크스테이션, us-east-1/us-west-2 등
 *                     (GPU processing 쿼터 0 은 파이프라인이 SmokeEval 을 Training Job 으로 돌려 우회).
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
