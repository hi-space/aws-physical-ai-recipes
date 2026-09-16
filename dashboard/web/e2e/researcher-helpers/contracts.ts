/** Wire views only. Never import server modules: they may initialize AWS clients. */
export interface Principal {
  user: string;
  subject: string;
  role: 'viewer' | 'researcher' | 'admin';
  features: { eks: boolean; fsx: boolean };
  project?: { id: string };
}
export interface Project {
  id: string;
  namespace: string;
  queue: string;
  members: Record<string, 'viewer' | 'researcher' | 'project-admin'>;
}
export interface Recipe { id: string; yaml: string }
export interface Receipt {
  uri: string;
  manifestUri: string;
  manifestHash: string;
  verifiedAt: string;
  objectCount: number;
  sizeBytes: number;
}
export interface Run {
  id: string;
  name: string;
  owner: string;
  ownerSubject: string;
  projectId: string;
  status: string;
  datasetSnapshots?: Record<string, Record<string, {
    name: string; version: number; fsxPath: string; uri: string; manifestHash: string;
  }>>;
}
export interface Task {
  name: string;
  phase: string;
  attempts: number;
  outputPath?: string;
  exitCode?: number;
  wrapperExitCode?: number;
  runtimeFailure?: boolean;
  artifactReceipts?: Record<string, Receipt>;
  publishedVersions?: { dataset: string; version: number }[];
  message?: string;
}
export interface RunDetail { workflow: Run; tasks: Task[] }
export interface Dataset {
  name: string;
  owner: string;
  ownerSubject?: string;
  projectId: string;
}
export interface Version extends Partial<Receipt> {
  dataset: string;
  version: number;
  uri: string;
  state: 'PENDING' | 'READY';
  fsxPath?: string;
  finalizationRequested?: boolean;
  finalizationError?: string;
  producedBy?: { workflowId: string; task: string };
}
export interface DatasetDetail { dataset: Dataset; versions: Version[] }
export interface ManagedSession {
  id: string;
  kind: 'terminal' | 'port-forward';
  owner: string;
  projectId: string;
  workflowId: string;
  taskName: string;
  replicaIndex: number;
  status: string;
  canOpen: boolean;
}
export interface FileListing {
  path: string;
  entries: { name: string; path: string; type: 'file' | 'directory'; size: number }[];
}
