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
 * GPU 인스턴스 Fallback 우선순위 (4-GPU, 12xlarge)
 *
 * 같은 SLURM 파티션에 여러 InstanceGroup으로 등록됨.
 * capacity 있는 인스턴스에 우선 할당되도록 SLURM이 관리.
 *
 * | 순위 | 인스턴스           | GPU              | VRAM  | 비고                        |
 * |------|-------------------|-----------------|-------|----------------------------|
 * | 1    | ml.g6e.12xlarge   | 4× L40S (48GB)  | 192GB | GA 안정, 대용량              |
 * | 2    | ml.g6.12xlarge    | 4× L4 (24GB)    | 96GB  | GA 오래됨, 가성비            |
 * | 3    | ml.g7e.12xlarge   | 4× RTX PRO 6000 | 384GB | 최신, Physical AI 최적       |
 * | 4    | ml.g5.12xlarge    | 4× A10G (24GB)  | 96GB  | 최후 fallback               |
 */
export const GPU_INSTANCE_FALLBACK: string[] = [
  'ml.g6e.12xlarge',
  'ml.g6.12xlarge',
  'ml.g7e.12xlarge',
  'ml.g5.12xlarge',
];

/**
 * Train 인스턴스 타입 프리셋 (단일 인스턴스 지정 시 사용)
 */
export const TRAIN_INSTANCE_PRESETS: Record<string, string> = {
  default: 'ml.g6e.12xlarge',
  light: 'ml.g5.4xlarge',
  perf: 'ml.g7e.12xlarge',
  heavy: 'ml.p4d.24xlarge',
  max: 'ml.p5.48xlarge',
};

export function buildGpuGroups(
  prefix: string,
  maxCountPerType: number,
  useSpot: boolean,
): InstanceGroupConfig[] {
  return GPU_INSTANCE_FALLBACK.map((instanceType, idx) => {
    const shortName = instanceType.replace('ml.', '').replace('.12xlarge', '');
    return {
      name: `${prefix}-${shortName}`,
      instanceType,
      instanceCount: 0,
      maxCount: maxCountPerType,
      useSpot,
      slurmNodeType: 'Compute' as const,
    };
  });
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
    instanceType: 'ml.g5.4xlarge',
    instanceCount: 0,
    maxCount: 1,
    useSpot: false,
    slurmNodeType: 'Compute',
  },
};
