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
