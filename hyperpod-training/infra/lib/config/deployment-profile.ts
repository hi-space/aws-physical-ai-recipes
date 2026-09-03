/**
 * 배포 프로필
 *
 * - personal        : 개인 계정(기본). GPU 워크스테이션(g6e/g6), 전 모듈 진행.
 * - workshop-studio : Workshop Studio 이벤트 계정. cluster 허용 타입이
 *                     ml.g5.2xlarge/8xlarge/12xlarge라 head 노드를 ml.g5.2xlarge로 만든다.
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
