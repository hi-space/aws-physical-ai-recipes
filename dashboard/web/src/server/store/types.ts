import type { WorkflowSpec } from '../workflow/schema';

export type WorkflowStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
export type TaskPhase = 'WAITING' | 'QUEUED' | 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'SKIPPED';

export const TERMINAL_WF: ReadonlySet<WorkflowStatus> = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED']);
export const TERMINAL_TASK: ReadonlySet<TaskPhase> = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'SKIPPED']);

export interface Workflow {
  id: string;
  name: string;
  namespace: string;
  owner: string;
  status: WorkflowStatus;
  spec: WorkflowSpec;
  specYaml: string;
  vars: Record<string, string>;
  templateId?: string;
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
  attempts: number;
  replicas: number;
  startedAt?: string;
  finishedAt?: string;
  queuedAt?: string;
  message?: string;
  outputPath?: string;
  publishedVersions?: { dataset: string; version: number }[];
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
  dataset: string;
  version: number;
  /** s3://bucket/prefix/ */
  uri: string;
  fsxPath?: string;
  sizeBytes?: number;
  objectCount?: number;
  tags: string[];
  producedBy?: { workflowId: string; task: string };
  createdAt: string;
  createdBy: string;
  note?: string;
}

export interface TemplateParam {
  name: string;
  label: string;
  type: 'string' | 'number' | 'select' | 'boolean' | 'text';
  default?: string;
  options?: string[];
  help?: string;
}

export interface Template {
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
  id: string;
  kind: 'tensorboard' | 'jupyter';
  namespace: string;
  owner: string;
  logDir?: string;
  /** Kubernetes deployment/service name */
  name: string;
  createdAt: string;
  status?: string;
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
