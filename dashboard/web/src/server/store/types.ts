import type { TopologyPlan } from '../workflow/topology/types';
import type { TopologyDiagnostics } from '../workflow/topology/observe';
import type { WorkflowSpec } from '../workflow/schema';
import type { ExecutionProfilePin } from '../workflow/execution-profile-policy';
export type WorkflowStatus = 'PENDING' | 'RUNNING' | 'CANCELLING' | 'FINALIZING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
export type TaskPhase = 'WAITING' | 'LAUNCHING' | 'INITIALIZING' | 'RETRY_WAIT' | 'CANCELLING' | 'FINALIZING' | 'QUEUED' | 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'SKIPPED';
export const TERMINAL_WF: ReadonlySet<WorkflowStatus> = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED']);
export const TERMINAL_TASK: ReadonlySet<TaskPhase> = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'SKIPPED']);
/** Trusted API/preflight metadata, not part of the user workflow YAML schema. */
export interface TaskImagePin {
  image: string;
  profileId: string;
  profileVersion: number;
  checkedAt: string;
}
export type TaskImagePins = Record<string, TaskImagePin>;
export interface Workflow {
  projectId?: string;
  ownerSubject?: string;
  id: string;
  name: string;
  namespace: string;
  owner: string;
  status: WorkflowStatus;
  spec: WorkflowSpec;
  specYaml: string;
  backendId?: string;
  backendConfigHash?: string;
  specHash?: string;
  imagePins?: TaskImagePins;
  executionProfilePins?: Record<string, ExecutionProfilePin>;
  preflightReviewedBy?: string;
  preflightReviewedAt?: string;
  datasetSnapshots?: Record<string, Record<number, DatasetSnapshot>>;
  vars: Record<string, string>;
  templateId?: string;
  templateVersion?: number;
  templateContentHash?: string;
  templateModified?: boolean;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  message?: string;
  taskCount: number;
  succeededCount: number;
  failedCount: number;
  labels?: Record<string, string>;
}
export interface Task {
  workflowId: string;
  name: string;
  phase: TaskPhase;
  jobName?: string;
  jobUid?: string;
  workloadKind?: 'Job' | 'JobSet';
  groupId?: string;
  attemptEpoch?: string;
  /** Stored only on the first task of a native-topology admission unit. */
  topologyPlan?: TopologyPlan;
  topologyDiagnostics?: TopologyDiagnostics;
  /** The launch compiler's decision, persisted before creating this attempt. */
  runtimeWrapped?: boolean;
  runtimeFailure?: boolean;
  /** Container wrapper exit, kept separate from the original application exitCode. */
  wrapperExitCode?: number;
  launchIntentAt?: string;
  admittedAt?: string;
  nextRetryAt?: string;
  cleanupTarget?: 'RETRY_WAIT' | 'FAILED' | 'CANCELLED' | 'SUCCEEDED';
  failureReason?: string;
  exitCode?: number;
  observedPhase?: TaskPhase;
  ignoredByGroupPolicy?: boolean;
  artifactReceipts?: Record<string, ArtifactReceipt>;
  attempts: number;
  replicas: number;
  startedAt?: string;
  finishedAt?: string;
  queuedAt?: string;
  message?: string;
  outputPath?: string;
  publishedVersions?: {
    dataset: string;
    version: number;
  }[];
  updatedAt: string;
}
export interface WorkflowEvent {
  workflowId: string;
  ts: string;
  seq: number;
  type: 'info' | 'warning' | 'error';
  source: 'controller' | 'kubernetes' | 'user';
  task?: string;
  reason: string;
  message: string;
}
export interface Dataset {
  projectId?: string;
  ownerSubject?: string;
  name: string;
  description?: string;
  owner: string;
  tags: string[];
  latestVersion: number;
  createdAt: string;
  updatedAt: string;
  format?: string;
}
export interface DatasetVersion {
  /** Certified aggregate broker metadata bytes, excluding paginated signed URLs. */
  hydrationBytes?: number;
  selection?: { include?: string[]; exclude?: string[] };
  projectId?: string;
  ownerSubject?: string;
  dataset: string;
  version: number;
  /** s3://bucket/prefix/ */
  uri: string;
  fsxPath?: string;
  sizeBytes?: number;
  objectCount?: number;
  tags: string[];
  producedBy?: {
    workflowId: string;
    task: string;
  };
  publicationId?: string;
  producedAttempt?: number;
  manifestUri?: string;
  manifestVersionId?: string;
  manifestHash?: string;
  verifiedAt?: string;
  state?: 'PENDING' | 'READY';
  versionRevision?: number;
  imported?: boolean;
  finalizationRequested?: boolean;
  finalizationError?: string;
  createdAt: string;
  createdBy: string;
  note?: string;
}
export interface TemplateParam {
  name: string;
  label: string;
  type: 'string' | 'number' | 'select' | 'boolean' | 'text' | 'dataset';
  default?: string;
  options?: string[];
  help?: string;
  versionParam?: string;
}
export interface Template {
  templateVersion?: number;
  projectId?: string;
  ownerSubject?: string;
  id: string;
  title: string;
  description: string;
  category: 'simulation' | 'training' | 'evaluation' | 'data' | 'setup' | 'custom';
  builtin: boolean;
  yaml: string;
  params: TemplateParam[];
  requires?: ('gpu' | 'fsx' | 'mlflow')[];
  createdBy?: string;
  createdAt: string;
}
export interface Session {
  backendId?: string;
  backendConfigHash?: string;
  projectId?: string;
  ownerSubject?: string;
  id: string;
  kind: 'tensorboard' | 'jupyter' | 'code-server' | 'terminal' | 'port-forward' | 'dcv';
  namespace: string;
  owner: string;
  logDir?: string;
  /** Managed Job name; legacy records used a Deployment/Service name. */
  name: string;
  createdAt: string;
  status?: string;
  queue?: string;
  expiresAt?: string;
  revokedAt?: string;
  closedAt?: string;
  revision?: number;
  managedJob?: boolean;
  provisioningUntil?: string;
  image?: string;
  runtimeImage?: string;
  jobUid?: string;
  podName?: string;
  podUid?: string;
  hostNetwork?: boolean;
  trustedExecution?: boolean;
  container?: string;
  port?: number;
  portName?: string;
  nodeName?: string;
  workspacePath?: string;
  workflowId?: string;
  taskName?: string;
  groupId?: string;
  attempt?: number;
  attemptEpoch?: string;
  replicaIndex?: number;
  message?: string;
  ssmTarget?: string;
  dcvSessionId?: string;
  /** Source authority for a session derived from an API token; never contains a bearer. */
  authMethod?: 'alb' | 'cognito' | 'token';
  tokenId?: string;
  tokenProjectId?: string;
  tokenRole?: 'viewer' | 'researcher';
  tokenExpiresAt?: string;
}
export interface AuditEntry {
  ts: string;
  seq: number;
  actor: string;
  role: string;
  action: string;
  target?: string;
  result: 'ok' | 'error';
  message?: string;
}
export interface Settings {
  notifyOn: ('SUCCEEDED' | 'FAILED' | 'CANCELLED')[];
  defaultNamespace: string;
  defaultPriority?: string;
}
export interface DatasetSnapshot {
  name: string;
  version: number;
  fsxPath: string;
  uri: string;
  manifestHash?: string;
}
export interface ArtifactReceipt {
  manifestVersionId?: string;
  hydrationBytes?: number;
  uri: string;
  manifestUri: string;
  manifestHash: string;
  verifiedAt: string;
  objectCount: number;
  sizeBytes: number;
}
export interface RunLease {
  runId: string;
  holder: string;
}
export interface OutboxEntry {
  kind: 'complete' | 'notify';
  idempotencyKey: string;
  deliveredAt?: string;
  attempts: number;
  nextAttemptAt?: string;
  lastError?: string;
}
