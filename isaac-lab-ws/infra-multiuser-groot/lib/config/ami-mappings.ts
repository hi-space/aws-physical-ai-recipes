/**
 * AMI 매핑 설정 모듈
 *
 * 리전별·Ubuntu 버전별 AMI ID 매핑을 관리한다.
 * DCV Instance용 AMI와 Batch ECS Optimized AMI를 포함한다.
 *
 * DCV AMI 전략: Deep Learning OSS Nvidia Driver AMI GPU PyTorch 사용
 * - stable(22.04): PyTorch 2.4.1 (Ubuntu 22.04) 20250623
 *   NVIDIA 드라이버 550 사전 설치 → UserData에서 570으로 자연 업그레이드
 * - latest(24.04): PyTorch 2.9 (Ubuntu 24.04) 20260226
 *   NVIDIA 드라이버 580 사전 설치 → nvidia-driver.sh에서 570으로 교체
 * - 드라이버 교체는 lspci 기반 xorg.conf 생성으로 커널 모듈 의존성 없음
 * - DLAMI에는 AWS CLI, NVIDIA 드라이버, Docker, PyTorch가 사전 설치됨
 *
 * Batch AMI: SSM Parameter /aws/service/ecs/optimized-ami/amazon-linux-2/gpu/recommended/image_id
 *
 * 지원 리전: 13개 (g6.12xlarge 슬롯 존재 확인, Baywatch 2026-03-07 기준)
 */

/** 지원 리전 목록 (g6+g5 모두 지원하는 12개 리전, Baywatch 2026-03-07 기준) */
export const SUPPORTED_REGIONS = [
  'us-east-1',       // 버지니아 (g6:4,394 + g5:5,836 = 10,230)
  'us-west-2',       // 오레곤 (g6:1,824 + g5:3,168 = 4,992)
  'us-east-2',       // 오하이오 (g6:750 + g5:1,938 = 2,688)
  'eu-central-1',    // 프랑크푸르트 (g6:948 + g5:288 = 1,236)
  'ap-south-1',      // 뭄바이 (g6:101 + g5:148 = 249)
  'eu-west-2',       // 런던 (g6:162 + g5:60 = 222)
  'ap-northeast-1',  // 도쿄 (g6:95 + g5:116 = 211)
  'ca-central-1',    // 캐나다 (g6:130 + g5:64 = 194)
  'ap-southeast-2',  // 시드니 (g6:63 + g5:94 = 157)
  'ap-northeast-2',  // 서울 (g6:56 + g5:84 = 140)
  'eu-north-1',      // 스톡홀름 (g6:39 + g5:68 = 107)
  'sa-east-1',       // 상파울루 (g6:61 + g5:34 = 95)
] as const;

/**
 * DCV Instance용 AMI 매핑 (리전 × Ubuntu 버전)
 *
 * 키 구조: DCV_AMI_MAPPING[리전][Ubuntu버전] → AMI ID
 * Ubuntu 버전: '2204' (22.04), '2404' (24.04)
 *
 * stable(22.04): Deep Learning OSS Nvidia Driver AMI GPU PyTorch 2.4.1 20250623
 * latest(24.04): Deep Learning OSS Nvidia Driver AMI GPU PyTorch 2.9 20260226
 */
export const DCV_AMI_MAPPING: Record<string, Record<string, string>> = {
  'us-east-1': {
    '2204': 'ami-0aee7b90d684e107d',
    '2404': 'ami-0aad28499825d76c3', // PyTorch 2.9 (Ubuntu 24.04) 20260226
  },
  'us-west-2': {
    '2204': 'ami-0ed3bd866951103a1',
    '2404': 'ami-0233d2606cf2ca76c',
  },
  'eu-central-1': {
    '2204': 'ami-03aa80bc63bbd3638',
    '2404': 'ami-0e4b2dc97de48343f',
  },
  'us-east-2': {
    '2204': 'ami-08562b09ef1f92be3',
    '2404': 'ami-01bcb63b59890d14d',
  },
  'eu-west-2': {
    '2204': 'ami-037dda7c431734f81',
    '2404': 'ami-07f52e4c3fe856f3c',
  },
  'ca-central-1': {
    '2204': 'ami-0ba45062c72b9cd9a',
    '2404': 'ami-09f189a9ae4a97679',
  },
  'ap-south-1': {
    '2204': 'ami-049200058bf05680c',
    '2404': 'ami-019855a64b8c18671',
  },
  'ap-northeast-1': {
    '2204': 'ami-01e1a167769a23572',
    '2404': 'ami-0d56e4afbb8976425',
  },
  'ap-southeast-2': {
    '2204': 'ami-0c42ab963741b294e',
    '2404': 'ami-09fce48433762aff9',
  },
  'sa-east-1': {
    '2204': 'ami-0fdc37cf0eb8b78e6',
    '2404': 'ami-0710923f6783c964e',
  },
  'ap-northeast-2': {
    '2204': 'ami-0e8f4fdb799f677ca',
    '2404': 'ami-089cb40698662fd5b',
  },
  'eu-north-1': {
    '2204': 'ami-00b0ed0217144c6bb',
    '2404': 'ami-0c9135edafab62b37',
  },
};


/**
 * Batch ECS Optimized GPU AMI 매핑 (리전별)
 *
 * SSM Parameter: /aws/service/ecs/optimized-ami/amazon-linux-2/gpu/recommended/image_id
 * 2026-03-07 조회 결과
 */
export const BATCH_AMI_MAPPING: Record<string, string> = {
  'us-east-1': 'ami-06a35af3c83f93d26',
  'us-west-2': 'ami-00c5c872f48d930e6',
  'eu-central-1': 'ami-0945883b4dc7f462d',
  'us-east-2': 'ami-0cfcccb61a5e1b2cb',
  'eu-west-2': 'ami-081fab966ac8c34e1',
  'ca-central-1': 'ami-06883cf760401b5dc',
  'ap-south-1': 'ami-07c839d514b8f0236',
  'ap-northeast-1': 'ami-043caf61707678753',
  'ap-southeast-2': 'ami-0f9f8eea3aa91bc78',
  'sa-east-1': 'ami-00ccda32b7f5fea0b',
  'ap-northeast-2': 'ami-064ed69c55514d586',
  'eu-north-1': 'ami-0d4af4cad3d9f4e93',
};

/**
 * DCV Instance용 AMI ID를 조회한다.
 */
export function getDcvAmi(region: string, ubuntuVersion: string): string {
  const regionMapping = DCV_AMI_MAPPING[region];
  if (!regionMapping) {
    throw new Error(
      `지원하지 않는 리전입니다: ${region}. 지원 리전: ${SUPPORTED_REGIONS.join(', ')}`,
    );
  }
  const amiId = regionMapping[ubuntuVersion];
  if (!amiId) {
    throw new Error(
      `리전 ${region}에서 Ubuntu ${ubuntuVersion} 버전의 AMI를 찾을 수 없습니다.`,
    );
  }
  return amiId;
}

/**
 * Batch ECS Optimized AMI ID를 조회한다.
 */
export function getBatchAmi(region: string): string {
  const amiId = BATCH_AMI_MAPPING[region];
  if (!amiId) {
    throw new Error(
      `지원하지 않는 리전입니다: ${region}. 지원 리전: ${SUPPORTED_REGIONS.join(', ')}`,
    );
  }
  return amiId;
}
