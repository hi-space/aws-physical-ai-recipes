/**
 * 버전 프로필 설정 모듈
 *
 * Isaac Lab 환경의 소프트웨어 스택 조합을 정의한다.
 * 새 프로필 추가 시 VERSION_PROFILES 객체에 항목만 추가하면
 * VersionProfileName 타입이 자동으로 확장된다.
 */

/**
 * 버전 프로필 인터페이스
 * 각 프로필이 포함해야 하는 소프트웨어 스택 정보를 정의한다.
 */
export interface VersionProfile {
  /** Ubuntu 버전 (예: '2004', '2204', '2404') */
  ubuntuVersion: string;
  /** ROS2 배포판 (예: 'foxy', 'humble', 'jazzy') */
  ros2Distro: string;
  /** NVIDIA 드라이버 버전 (예: '535', '550', '570') */
  nvidiaDriverVersion: string;
  /** Isaac Sim 버전 (예: '4.5.0', '5.1.0', '') — 빈 문자열이면 미사용 */
  isaacSimVersion: string;
  /** Isaac Lab 버전 (선택, 예: '2.3.2') */
  isaacLabVersion?: string;
  /** CUDA 버전 (예: '12.x', '12.8') */
  cudaVersion: string;
  /** Isaac Sim Docker 이미지 URI 또는 빈 문자열 */
  isaacSimDockerImage: string;
  /** v4l2loopback-dkms 설치 여부 */
  installV4l2Loopback: boolean;
}

/**
 * 버전 프로필 매핑 객체
 *
 * - latest: 워크숍 기본 조합 (Isaac Sim 5.1.0 + Isaac Lab 2.3.2)
 * - stable: 이전 조합 (Isaac Sim 4.5.0 + Isaac Lab 2.1.1)
 *
 * isaacLabVersion은 업스트림이 명시한 Isaac Sim 대응 버전을 따른다.
 * Isaac Lab v2.1.1까지 Isaac Sim 4.5.0, v2.2.x는 5.0.0, v2.3.x는 5.1.0을 대상으로 한다.
 *
 * legacy 프로필은 제거됨:
 *   Ubuntu 20.04 EOL(2025-04), ROS2 Foxy EOL(2023-06),
 *   Isaac Sim/Lab 미포함으로 워크숍 실행 불가
 *
 * Isaac Sim 6.0.0(GA 2026-03-16) / 6.0.1(2026-06-22)은 Python 3.12만 지원하며
 * 이 리포에서 검증되지 않아 미포함.
 */
export const VERSION_PROFILES = {
  stable: {
    ubuntuVersion: '2204',
    ros2Distro: 'humble',
    nvidiaDriverVersion: '570',
    isaacSimVersion: '4.5.0',
    isaacLabVersion: '2.1.1',
    cudaVersion: '12.x',
    isaacSimDockerImage: 'nvcr.io/nvidia/isaac-sim:4.5.0',
    installV4l2Loopback: false,
  },
  latest: {
    ubuntuVersion: '2404',
    ros2Distro: 'jazzy',
    nvidiaDriverVersion: '570',
    isaacSimVersion: '5.1.0',
    isaacLabVersion: '2.3.2',
    cudaVersion: '12.8',
    isaacSimDockerImage: 'nvcr.io/nvidia/isaac-sim:5.1.0',
    installV4l2Loopback: false,
  },
} as const satisfies Record<string, VersionProfile>;

/**
 * 버전 프로필 이름 타입
 * VERSION_PROFILES 키에서 자동 추론된다.
 * 현재: 'stable' | 'latest'
 * 새 프로필 추가 시 자동 확장됨.
 */
export type VersionProfileName = keyof typeof VERSION_PROFILES;
