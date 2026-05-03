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
  sim: InstanceGroupConfig;
  train: InstanceGroupConfig;
  debug: InstanceGroupConfig;
}

/**
 * Train 인스턴스 타입 프리셋
 *
 * | 프리셋  | 인스턴스           | GPU             | 적합한 작업                    |
 * |---------|-------------------|-----------------|-------------------------------|
 * | default | ml.g6e.12xlarge   | 4× L40S (48GB)  | GR00T-3B LoRA/Full SFT        |
 * | heavy   | ml.p4d.24xlarge   | 8× A100 (40GB)  | 대규모 VLA, 멀티노드            |
 * | max     | ml.p5.48xlarge    | 8× H100 (80GB)  | 큰 모델 full fine-tuning       |
 */
export const TRAIN_INSTANCE_PRESETS: Record<string, string> = {
  default: 'ml.g6e.12xlarge',
  heavy: 'ml.p4d.24xlarge',
  max: 'ml.p5.48xlarge',
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
  sim: {
    name: 'sim',
    instanceType: 'ml.g5.12xlarge',
    instanceCount: 0,
    maxCount: 16,
    useSpot: true,
    slurmNodeType: 'Compute',
  },
  train: {
    name: 'train',
    instanceType: 'ml.g6e.12xlarge',
    instanceCount: 0,
    maxCount: 4,
    useSpot: false,
    slurmNodeType: 'Compute',
  },
  debug: {
    name: 'debug',
    instanceType: 'ml.g5.4xlarge',
    instanceCount: 0,
    maxCount: 1,
    useSpot: false,
    slurmNodeType: 'Compute',
  },
};
