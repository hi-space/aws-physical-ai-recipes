import type { DatasetVersion } from '../store/types';
import type { DatasetPin, ObjectPin } from './types';
import type { CheckpointDirectory, CheckpointDirectorySummary } from './bundles';

export interface PipelineObjectSource {
  uri: string; bucket: string; key: string; versionId?: string; etag: string;
  bytes: number; sha256: string;
}
export interface PipelineJobSource {
  step: string; jobArn: string; jobType: 'training' | 'processing'; image: string;
  completedAt: string; inputs: { channel: string; uri: string; verification: 'backend-declared-uri' }[];
}
export interface PipelineReportSource extends PipelineJobSource { uri: string }
export interface PipelineProvenance {
  executionArn: string; pipelineName: string; definitionHash: string; completedAt: string;
  ownerSubject?: string;
  training: PipelineJobSource & { artifactUri: string };
  reports: PipelineReportSource[];
  package?: { arn: string; group: string; modelUri: string; observedApprovalStatus: string };
}
export interface PipelineArchivedReport {
  step: string; report: ObjectPin; videos: ObjectPin[]; source: PipelineReportSource;
  sourceObject: PipelineObjectSource;
}
export interface PipelineArchiveManifest {
  schemaVersion: 1; identity: string; createdAt: string;
  source: PipelineProvenance; sourceObject: PipelineObjectSource;
  objects: ObjectPin[]; checkpointPath: string;
  directory: CheckpointDirectory; directoryManifestPath: string;
  reports: PipelineArchivedReport[];
}
export interface PipelineArchiveRecord {
  id: string; projectId: string; ownerSubject: string; owner: string;
  executionArn: string; trainingStep: string; reportSteps: string[];
  status: 'PENDING' | 'ARCHIVING' | 'READY' | 'FAILED' | 'CANCELLED';
  createdAt: string; updatedAt: string; error?: string;
  provenance?: PipelineProvenance;
  dataset?: DatasetPin; version?: number; datasetName: string;
  checkpoint?: ObjectPin; directory?: CheckpointDirectorySummary; directoryManifest?: ObjectPin;
  reports?: PipelineArchivedReport[]; sourceObject?: PipelineObjectSource;
}
export interface PipelineDatasetVersion extends DatasetVersion { pipelineArchiveId: string }
export const pipelineArchiveKey = (project: string, id: string) => ({ pk: `PIPELINE_ARCHIVE#${project}#${id}`, sk: 'META' });
export const pipelineExecutionKey = (arn: string) => ({ pk: `PIPELINE_EXECUTION#${arn}`, sk: 'META' });
