import { DeploymentProfile } from './deployment-profile';

export interface InstanceGroupConfig {
  name: string;
  instanceType: string;
  instanceCount: number;
  maxCount: number;
  useSpot: boolean;
  slurmNodeType: 'Controller' | 'Compute';
}

export interface ClusterDefaults {
  head: InstanceGroupConfig;
  gpu: InstanceGroupConfig[];
  debug: InstanceGroupConfig;
}

/**
 * AMI 보안 패치 자동 적용 스케줄 (ScheduledUpdateConfig.ScheduleExpression)
 *
 * 매월 둘째 일요일 18:00 UTC = 한국시간 월요일 오전 3시.
 * 이 값을 비워두면 패치가 수동 작업(UpdateClusterSoftware 직접 호출)으로 남으므로,
 * 새 클러스터는 항상 스케줄을 켠 상태로 생성한다.
 *
 * 요일은 반드시 숫자로 쓴다. n번째 요일(`#`) 문법은 AWS가 검증하는 정규식에서
 * 숫자 요일만 허용하기 때문이다(day-of-week 그룹이
 * `MON|TUE|...|SUN|[1-7]|?|L|[1-7]#[1-5]|[1-7]L` 이라 `SUN#2`는 매칭되지 않음).
 * `cron(00 18 ? * SUN#2 *)`로 두면 change set early validation 단계에서
 * "does not match pattern" 으로 거부되어 배포 자체가 실패한다.
 * EventBridge cron 규약(1=SUN … 7=SAT)에 따라 `1#2` = 둘째 일요일.
 *
 * 주의 (Slurm 클러스터 한정):
 *  - 배치/롤링 업데이트와 CloudWatch 자동 롤백(DeploymentConfig)은 EKS 전용이라
 *    지정할 수 없다. 예약 시각에 인스턴스 그룹 전체가 한꺼번에 교체된다.
 *  - 패치는 루트 볼륨을 새 AMI로 교체한다. /fsx(FSx Lustre)는 유지되지만
 *    루트 볼륨의 데이터(/home/ubuntu, Slurm accounting DB)는 사라진다.
 *  - 워크로드 인식 자동 패치(AutoPatchConfig)는 EKS 전용이므로 Slurm에서는 못 쓴다.
 *
 * @see https://docs.aws.amazon.com/sagemaker/latest/dg/sagemaker-hyperpod-release-ami-update.html
 */
export const DEFAULT_AMI_UPDATE_SCHEDULE = 'cron(00 18 ? * 1#2 *)';

/**
 * GPU 인스턴스 그룹 프로필
 *
 * - core     : 워크숍 기본. 학습 그룹 gpu-g5-8x 하나만 만든다(debug 그룹과 같은 ml.g5.8xlarge —
 *              학습 job은 GPU 1장만 쓰고, 단일 GPU 타입이 용량을 구하기 쉽다). Workshop Studio의
 *              SageMaker 허용 목록(cluster: ml.g5.2xlarge/8xlarge/12xlarge, ml.trn1.32xlarge)
 *              안에 있는 타입만 쓰므로 CreateCluster 스펙에 비허용 타입이 섞이지 않는다.
 * - extended : core + g6e/g6/p4d/p5 그룹. 쿼터가 있는 개인 계정에서 더 큰 모델·
 *              더 빠른 GPU로 옮겨갈 때 `-c gpuGroups=extended`로 배포한다.
 *              (모든 그룹은 노드 0으로 생성되므로 정의만으로는 비용이 없다.)
 *
 * | 인스턴스           | GPU              | VRAM  | 프로필    | 용도                    |
 * |-------------------|-----------------|-------|----------|------------------------|
 * | ml.g5.8xlarge     | 1× A10G (24GB)  | 24GB  | core     | 기본 학습 (debug 와 동일)  |
 * | ml.g5.12xlarge    | 4× A10G (24GB)  | 96GB  | extended | 멀티 GPU 학습            |
 * | ml.g6e.12xlarge   | 4× L40S (48GB)  | 192GB | extended | 더 빠른 학습 (g6e 쿼터 필요) |
 * | ml.g6e.24xlarge   | 4× L40S (48GB)  | 192GB | extended | 더 많은 CPU/RAM          |
 * | ml.g6e.48xlarge   | 8× L40S (48GB)  | 384GB | extended | 대규모 학습              |
 * | ml.g6.12xlarge    | 4× L4 (24GB)    | 96GB  | extended | 추론/경량 학습           |
 * | ml.g6.24xlarge    | 4× L4 (24GB)    | 96GB  | extended | 더 많은 CPU/RAM          |
 * | ml.g6.48xlarge    | 8× L4 (24GB)    | 192GB | extended | 대규모 L4                |
 * | ml.p4d.24xlarge   | 8× A100 (40GB)  | 320GB | extended | 대규모 학습 (NVLink)     |
 * | ml.p5.48xlarge    | 8× H100 (80GB)  | 640GB | extended | 최대 성능 (NVLink)       |
 */
export type GpuGroupProfile = 'core' | 'extended';

export const CORE_GPU_INSTANCES: { type: string; shortName: string }[] = [
  { type: 'ml.g5.8xlarge', shortName: 'g5-8x' },
];

export const EXTENDED_GPU_INSTANCES: { type: string; shortName: string }[] = [
  ...CORE_GPU_INSTANCES,
  { type: 'ml.g5.12xlarge', shortName: 'g5-12x' },
  { type: 'ml.g6e.12xlarge', shortName: 'g6e-12x' },
  { type: 'ml.g6e.24xlarge', shortName: 'g6e-24x' },
  { type: 'ml.g6e.48xlarge', shortName: 'g6e-48x' },
  { type: 'ml.g6.12xlarge', shortName: 'g6-12x' },
  { type: 'ml.g6.24xlarge', shortName: 'g6-24x' },
  { type: 'ml.g6.48xlarge', shortName: 'g6-48x' },
  { type: 'ml.p4d.24xlarge', shortName: 'p4d' },
  { type: 'ml.p5.48xlarge', shortName: 'p5' },
];

/** 기본(core) 프로필의 GPU 인스턴스 목록. */
export const GPU_INSTANCES = CORE_GPU_INSTANCES;

/**
 * Train 인스턴스 타입 프리셋 (default 는 core, 나머지는 extended 프로필에서만 그룹이 존재)
 */
export const TRAIN_INSTANCE_PRESETS: Record<string, string> = {
  default: 'ml.g5.8xlarge',
  multi: 'ml.g5.12xlarge',
  perf: 'ml.g6e.12xlarge',
  heavy: 'ml.p4d.24xlarge',
  max: 'ml.p5.48xlarge',
};

export function buildGpuGroups(
  prefix: string,
  maxCountPerType: number,
  useSpot: boolean,
  profile: GpuGroupProfile = 'core',
): InstanceGroupConfig[] {
  const instances = profile === 'extended' ? EXTENDED_GPU_INSTANCES : CORE_GPU_INSTANCES;
  return instances.map(({ type, shortName }) => ({
    name: `${prefix}-${shortName}`,
    instanceType: type,
    instanceCount: 0,
    maxCount: maxCountPerType,
    useSpot,
    slurmNodeType: 'Compute' as const,
  }));
}

/**
 * 프로필별 head(컨트롤러) 노드 타입.
 * Workshop Studio 계정은 cluster usage 허용 타입이 ml.g5.2xlarge/8xlarge/12xlarge, ml.trn1.32xlarge
 * 뿐이고 ml.m5.xlarge 기본 한도가 0이라 CreateCluster가 거부된다 → 허용 타입 중 최소인 g5.2xlarge.
 */
export const HEAD_INSTANCE_BY_PROFILE: Record<DeploymentProfile, string> = {
  personal: 'ml.m5.xlarge',
  'workshop-studio': 'ml.g5.2xlarge',
};

export const DEFAULT_CLUSTER_CONFIG: ClusterDefaults = {
  head: {
    name: 'head',
    instanceType: 'ml.m5.xlarge',
    instanceCount: 1,
    maxCount: 1,
    useSpot: false,
    slurmNodeType: 'Controller',
  },
  gpu: buildGpuGroups('gpu', 4, false),
  debug: {
    name: 'debug',
    instanceType: 'ml.g5.8xlarge',
    instanceCount: 0,
    maxCount: 1,
    useSpot: false,
    slurmNodeType: 'Compute',
  },
};
