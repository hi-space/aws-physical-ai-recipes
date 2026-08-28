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
 * 요일은 숫자(1-7) 대신 이름(SUN)을 쓴다. AWS 문서의 요일 숫자 기준이
 * 페이지 내에서 서로 어긋나 있어(1=월/1=일) 이름이 유일하게 모호하지 않다.
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
export const DEFAULT_AMI_UPDATE_SCHEDULE = 'cron(00 18 ? * SUN#2 *)';

/**
 * GPU 인스턴스 타입 목록 (g6/g6e + p 시리즈)
 *
 * | 인스턴스           | GPU              | VRAM  | 용도                        |
 * |-------------------|-----------------|-------|----------------------------|
 * | ml.g6e.12xlarge   | 4× L40S (48GB)  | 192GB | 기본 학습                    |
 * | ml.g6e.24xlarge   | 4× L40S (48GB)  | 192GB | 더 많은 CPU/RAM              |
 * | ml.g6e.48xlarge   | 8× L40S (48GB)  | 384GB | 대규모 학습                  |
 * | ml.g6.12xlarge    | 4× L4 (24GB)    | 96GB  | 추론/경량 학습               |
 * | ml.g6.24xlarge    | 4× L4 (24GB)    | 96GB  | 더 많은 CPU/RAM              |
 * | ml.g6.48xlarge    | 8× L4 (24GB)    | 192GB | 대규모 L4                    |
 * | ml.p4d.24xlarge   | 8× A100 (40GB)  | 320GB | 대규모 학습 (NVLink)         |
 * | ml.p5.48xlarge    | 8× H100 (80GB)  | 640GB | 최대 성능 (NVLink)           |
 */
export const GPU_INSTANCES: { type: string; shortName: string }[] = [
  { type: 'ml.g6e.12xlarge', shortName: 'g6e-12x' },
  { type: 'ml.g6e.24xlarge', shortName: 'g6e-24x' },
  { type: 'ml.g6e.48xlarge', shortName: 'g6e-48x' },
  { type: 'ml.g6.12xlarge', shortName: 'g6-12x' },
  { type: 'ml.g6.24xlarge', shortName: 'g6-24x' },
  { type: 'ml.g6.48xlarge', shortName: 'g6-48x' },
  { type: 'ml.p4d.24xlarge', shortName: 'p4d' },
  { type: 'ml.p5.48xlarge', shortName: 'p5' },
];

/**
 * Train 인스턴스 타입 프리셋
 */
export const TRAIN_INSTANCE_PRESETS: Record<string, string> = {
  default: 'ml.g6e.12xlarge',
  light: 'ml.g6e.4xlarge',
  perf: 'ml.g6e.48xlarge',
  heavy: 'ml.p4d.24xlarge',
  max: 'ml.p5.48xlarge',
};

export function buildGpuGroups(
  prefix: string,
  maxCountPerType: number,
  useSpot: boolean,
): InstanceGroupConfig[] {
  return GPU_INSTANCES.map(({ type, shortName }) => ({
    name: `${prefix}-${shortName}`,
    instanceType: type,
    instanceCount: 0,
    maxCount: maxCountPerType,
    useSpot,
    slurmNodeType: 'Compute' as const,
  }));
}

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
    instanceType: 'ml.g6e.4xlarge',
    instanceCount: 0,
    maxCount: 1,
    useSpot: false,
    slurmNodeType: 'Compute',
  },
};
