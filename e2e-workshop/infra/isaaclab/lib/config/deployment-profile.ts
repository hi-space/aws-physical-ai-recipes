/**
 * 배포 프로필
 *
 * - personal        : 개인 계정(기본). GPU 워크스테이션(g6e/g6), 전 모듈 진행.
 * - workshop-studio : Workshop Studio 이벤트 계정. EC2 G/P 계열 vCPU 한도가 0이라
 *                     CPU 워크스테이션(m6i.4xlarge 계열)을 쓰고 nvidia-driver.sh를 생략한다.
 *                     Isaac Sim 모듈(2·5·6·7)은 진행 불가, SageMaker/HyperPod 모듈만 진행.
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
