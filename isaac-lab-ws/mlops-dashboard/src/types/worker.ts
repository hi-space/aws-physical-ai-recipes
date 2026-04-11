export type WorkerStatus = 'RUNNING' | 'PENDING' | 'STOPPED' | 'FAILED';

export interface Worker {
  id: string;
  instanceId: string;
  batchJobId: string;
  batchJobQueue: string;
  status: WorkerStatus;
  publicIp: string;
  privateIp: string;
  instanceType: string;
  region: string;
  taskName: string;
  gpuCount: number;
  gpuUtilization: number;
  gpuMemoryUtilization: number;
  gpuTemperature: number;
  cpuUtilization: number;
  memoryUtilization: number;
  uptime: string;
  startedAt: string;
  ddpRank: number;
  ddpWorldSize: number;
  ddpBackend: string;
  experimentName: string;
  currentStep: number;
  totalSteps: number;
  currentReward: number;
  tags: Record<string, string>;
  rerunPort: number;
  rerunDataPort: number;
  tensorboardPort: number;
}

export interface TrainingMetrics {
  workerId: string;
  steps: number[];
  rewards: number[];
  episodeLengths: number[];
  policyLoss: number[];
  valueLoss: number[];
  learningRate: number[];
}

export interface Experiment {
  id: string;
  name: string;
  taskName: string;
  algorithm: string;
  hyperparams: Record<string, string | number>;
  workerIds: string[];
  status: WorkerStatus;
  startedAt: string;
  bestReward: number;
  currentStep: number;
  totalSteps: number;
}

export interface FleetSummary {
  total: number;
  running: number;
  pending: number;
  stopped: number;
  failed: number;
  avgGpuUtilization: number;
  totalGpus: number;
  bestReward: number;
}

export interface BatchJob {
  jobId: string;
  jobName: string;
  jobQueue: string;
  status: string;
  createdAt: string;
  startedAt: string;
  stoppedAt: string;
  container: {
    image: string;
    vcpus: number;
    memory: number;
    gpus: number;
  };
  tags: Record<string, string>;
}
