import type { TopologyInventory } from './topology/types';
import type { Job, Pod } from '../k8s/resources';
import type { Repo } from '../store/repo';
import type { ArtifactReceipt, Task, Workflow, RunLease } from '../store/types';
import type { TaskSpec } from './schema';
import type { SharedReadOnlyPath } from './storage-layout';
export interface JobSet {
  apiVersion?: string;
  kind?: string;
  metadata: Job['metadata'];
  spec: {
    suspend?: boolean;
    replicatedJobs: {
      name: string;
      replicas: number;
      template: {
        metadata: Omit<Job['metadata'], 'name'> & {
          name?: string;
        };
        spec: Job['spec'] & {
          completionMode?: 'Indexed' | 'NonIndexed';
        };
      };
    }[];
    [key: string]: unknown;
  };
  status?: {
    conditions?: {
      type: string;
      status: string;
      reason?: string;
      message?: string;
    }[];
    replicatedJobsStatus?: {
      name: string;
      succeeded?: number;
      failed?: number;
      active?: number;
      ready?: number;
    }[];
  };
}
export interface K8sPort {
  getJob(ns: string, name: string): Promise<Job | null>;
  listPods(ns: string, labelSelector: string): Promise<Pod[]>;
  createJob(ns: string, job: unknown): Promise<unknown>;
  deleteJob(ns: string, name: string): Promise<void>;
  upsertConfigMap(ns: string, name: string, data: Record<string, string>, labels: Record<string, string>): Promise<void>;
  upsertSecret(ns: string, name: string, data: Record<string, string>, labels: Record<string, string>): Promise<void>;
  ensureAttemptSecret?(ns: string, name: string, data: Record<string, string>, labels: Record<string, string>): Promise<{ uid: string }>;
  deleteByLabel(ns: string, kind: 'configmaps' | 'secrets', selector: string): Promise<void>;
  ensureNamespace(ns: string): Promise<void>;
  ensureFsxPvc(ns: string): Promise<void>;
  queueState(ns: string, jobName: string): Promise<'admitted' | 'pending' | 'evicted' | 'finished' | 'unknown'>;
  getJobSet?(ns: string, name: string): Promise<JobSet | null>;
  createJobSet?(ns: string, object: unknown): Promise<unknown>;
  deleteJobSet?(ns: string, name: string): Promise<void>;
}
export interface DeliveryContext {
  idempotencyKey: string;
  signal: AbortSignal;
  lease?: RunLease;
}
export interface GroupRuntimeState {
  epoch: string;
  /** Only true after every replica has finished initialization and crossed the barrier. */
  barrierReleased: boolean;
  startedAt?: string;
  tasks: Record<string, {
    phase: 'INITIALIZING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';
    exitCode?: number;
    message?: string;
  }>;
}
export interface TaskRuntimeOutcome {
  epoch: string;
  /** Raw application observation; action is evaluated only from application exits. */
  phase: 'INITIALIZING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  action?: 'COMPLETE' | 'FAIL' | 'RESCHEDULE';
  runtimeFailure: boolean;
  exitCode?: number;
  message?: string;
}
export interface ControllerDeps {
  repo: Repo;
  k8s: K8sPort;
  now: () => Date;
  notify: (subject: string, message: string) => Promise<void>;
  resolveCredential: (ref: string) => Promise<string>;
  mlflowTrackingUri?: string;
  dataBucket?: string;
  /** Destination for checkpoint.url:auto; resolved only by trusted server context. */
  artifactBucket?: string;
  leaseSeconds?: number;
  artifactPublisher?: {
    publish(input: {
      workflow: Workflow;
      task: Task;
      output: TaskSpec['outputs'][number];
      sourcePath: string;
      publicationId: string;
      attempt: number;
      signal: AbortSignal;
    }): Promise<({
      state: 'ready';
    } & ArtifactReceipt) | {
      state: 'pending';
      message?: string;
    }>;
  };
  completeWorkflow?: (workflow: Workflow, context: DeliveryContext) => Promise<void>;
  cancelSessions?: (workflow: Workflow, context: {
    signal: AbortSignal;
    groupId?: string;
    attempt?: number;
  }) => Promise<boolean>;
  /** Fence/cancel publication collectors on cancellation, failure or retry.
   * True only after the matching inventory Jobs and Pods are gone. */
  cancelArtifacts?: (workflow: Workflow, context: {
    signal: AbortSignal;
    taskNames?: string[];
    attempt?: number;
  }) => Promise<boolean>;
  cleanupCheckpointUploads?: (workflow: Workflow, context: {
    signal: AbortSignal; taskNames: string[]; attempt: number;
  }) => Promise<boolean>;
  /** Trusted executable available in the workload image; --contract JSON -- user argv. */
  runtimeCommand?: string;
  runtimeImage?: string;
  /** Trusted MJPEG sidecar image for `live: true` tasks. */
  liveImage?: string;
  runtimeEnvironment?: (workflow: Workflow, task: TaskSpec, epoch: string, attempt: number) => Record<string, string>;
  /** Final pre-create approval-head check; throw to veto. No image rewriting. */
  validateTaskPolicy?: (workflow: Workflow, task: TaskSpec) => Promise<void>;
  logs?: {
    reconcile(workflow: Workflow): Promise<void>;
    drain(workflow: Workflow, taskNames: string[], attempt: number): Promise<void>;
  };
  /** Server-selected vetted recipe mounts only; never populated from user YAML. */
  sharedReadOnlyPaths?: (workflow: Workflow, task: TaskSpec) => SharedReadOnlyPath[];
  workloadServiceAccount?: string;
  /** Fresh read-only inventory for a trusted namespace/queue topology registration. */
  topologyInventory?: (workflow: Workflow, signal: AbortSignal) => Promise<TopologyInventory>;
  groupRuntime?: {
    observe(workflow: Workflow, groupId: string, epoch: string, signal: AbortSignal): Promise<GroupRuntimeState>;
    /** Durably revoke epoch: late barriers, checkpoints, sessions and publications must reject it. */
    fence(workflow: Workflow, groupId: string, epoch: string, signal: AbortSignal): Promise<void>;
  };
}
