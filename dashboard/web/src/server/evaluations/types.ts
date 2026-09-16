import type { EvaluationMetrics, PromotionDecision, PromotionPolicy } from './promotion-policy';
import type { PipelineProvenance, PipelineObjectSource } from './pipeline-types';
import type { CheckpointDirectorySummary } from './bundles';

export interface ObjectPin {
  bucket: string;
  key: string;
  path: string;
  versionId: string;
  bytes: number;
  checksumSHA256: string;
  checksumType: 'FULL_OBJECT' | 'COMPOSITE';
  /** Full file SHA-256 only. A multipart composite checksum is never relabeled as this digest. */
  sha256?: string;
  sha256Verification?: 'streamed-version';
}
export interface DatasetPin {
  name: string;
  version: number;
  uri: string;
  manifestUri: string;
  manifestHash: string;
  manifestVersionId: string;
}
export interface SourceLineage {
  kind?: 'workflow' | 'sagemaker-pipeline';
  workflowId?: string;
  task: string;
  attempt?: number;
  image: string;
  workflowSpecHash?: string;
  dataset: DatasetPin;
  inputs: { name: string; version: number; uri: string; manifestHash: string }[];
  upstreamTasks: string[];
  pipeline?: PipelineProvenance & { archiveId: string; sourceObject: PipelineObjectSource };
}
export interface GateRecord {
  id: string;
  evaluationId: string;
  policy: PromotionPolicy;
  decision: PromotionDecision;
  approved: boolean;
  createdAt: string;
  ownerSubject: string;
}
export interface RegisteredModel {
  id: string;
  projectId: string;
  ownerSubject: string;
  name: string;
  createdAt: string;
  revision: number;
  source: SourceLineage;
  checkpoint: ObjectPin;
  normalization?: ObjectPin;
  checkpointBundle?: { path: string; manifest: ObjectPin; directory: CheckpointDirectorySummary };
  registryLink?: {
    arn: string; group: string; modelUri: string; observedApprovalStatus: string;
    sourceMeaning: 'smoke_only'; archiveId: string;
  };
  registryApproval?: {
    gateId: string; packageArn: string; status: 'PENDING' | 'CONFIRMED' | 'ERROR';
    requestedBy: string; requestedAt: string; confirmedAt?: string; error?: string;
  };
  bundle?: { path: string; manifest: ObjectPin; task: string; seed: number; simulator: Record<string, string> };
  evaluationLaunch?: { template: 'mujoco-render' | 'leisaac-evaluate'; href: string };
  evaluationUnavailableReason?: string;
  lastGate?: GateRecord;
  /** Application approval of this exact checkpoint/evaluation/policy; no SageMaker status is implied. */
  qualityApproval?: GateRecord;
}
export interface NormalizedEvaluation {
  metrics: EvaluationMetrics;
  task: string;
  seed: number;
  successRate: number;
  timeoutCount?: number;
  timeoutSeconds?: number;
  latencyMs?: { p50?: number; p95?: number; p99?: number };
  checkpointDigest: string;
  checkpointDigestKind?: 'file-sha256' | 'pai-directory-sha256-v1';
  normalizationDigest?: string;
  simulator: Record<string, string>;
  videoPaths: string[];
}
export interface ClosedLoopEvaluation extends Omit<NormalizedEvaluation, 'videoPaths'> {
  id: string;
  modelId: string;
  projectId: string;
  ownerSubject: string;
  createdAt: string;
  verification: 'published_runtime_report' | 'published_pipeline_report';
  source: SourceLineage;
  report: ObjectPin;
  primaryVideo: ObjectPin;
  inputMatch: 'dataset_snapshot' | 'same_run_task_output' | 'pipeline_model_input';
  reportedCheckpointDigest?: string;
}
export interface SmokeEvaluation {
  id: string; modelId: string; projectId: string; ownerSubject: string; createdAt: string;
  verification: 'published_pipeline_report'; inputMatch: 'pipeline_model_input';
  source: SourceLineage; report: ObjectPin; primaryVideo?: never;
  metrics: EvaluationMetrics & { kind: 'smoke' };
  checkpointDigest: string; task: string;
  smoke: { passed: boolean; allFinite: boolean; actionShape: number[]; error?: string };
  seed?: never; successRate?: never; latencyMs?: never; timeoutCount?: never;
  simulator?: never; normalizationDigest?: never;
}
export type ModelEvaluation = ClosedLoopEvaluation | SmokeEvaluation;
export interface PublishedOutput {
  dataset: string;
  version: number;
  workflowId?: string;
  pipelineExecutionArn?: string;
  task: string;
  createdAt: string;
}
export interface ModelsResponse {
  projectId: string;
  canWrite: boolean;
  models: RegisteredModel[];
  outputs: PublishedOutput[];
  cursor?: string;
  outputLimitReached: boolean;
  defaultPolicy: PromotionPolicy;
}
export interface ModelDetail {
  model: RegisteredModel;
  evaluations: ModelEvaluation[];
  gates: GateRecord[];
  canWrite: boolean;
  canPropagateRegistry?: boolean;
}
export interface LegacySource {
  name: string;
  status: 'ok' | 'not_configured' | 'error';
  error?: string;
  data?: unknown;
}
export interface LegacyModelsResponse {
  approvalMeaning: 'smoke_only';
  sources: LegacySource[];
}
