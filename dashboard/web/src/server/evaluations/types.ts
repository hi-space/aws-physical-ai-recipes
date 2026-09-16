import type { EvaluationMetrics, PromotionDecision, PromotionPolicy } from './promotion-policy';

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
  workflowId: string;
  task: string;
  attempt: number;
  image: string;
  workflowSpecHash: string;
  dataset: DatasetPin;
  inputs: { name: string; version: number; uri: string; manifestHash: string }[];
  upstreamTasks: string[];
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
  bundle?: { path: string; manifest: ObjectPin; task: string; seed: number; simulator: Record<string, string> };
  evaluationLaunch?: { template: 'mujoco-render'; href: string };
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
  normalizationDigest?: string;
  simulator: Record<string, string>;
  videoPaths: string[];
}
export interface ModelEvaluation extends Omit<NormalizedEvaluation, 'videoPaths'> {
  id: string;
  modelId: string;
  projectId: string;
  ownerSubject: string;
  createdAt: string;
  verification: 'published_runtime_report';
  source: SourceLineage;
  report: ObjectPin;
  primaryVideo: ObjectPin;
  inputMatch: 'dataset_snapshot' | 'same_run_task_output';
}
export interface PublishedOutput {
  dataset: string;
  version: number;
  workflowId: string;
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
