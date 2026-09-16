import { createHash } from 'node:crypto';
import type { Task, Workflow } from '../store/types';
import type { TaskSpec } from './schema';

/** Server-owned lineage; neither YAML nor a public submit body can set it. */
export interface CheckpointSource {
  workflowId: string;
  task: string;
  attempt: number;
  epoch: string;
}
export type RecoveryTask = Task & { checkpointRestoreSources?: CheckpointSource[] };
export type RecoveryWorkflow = Workflow & { retryOf?: string };
export interface RetryCheckpointContext {
  retryOf: string;
  sources: Record<string, CheckpointSource[]>;
}

export function checkpointURL(
  checkpoint: NonNullable<TaskSpec['checkpoint']>[number], index: number,
  scope: { workflowId: string; task: string; projectId?: string; artifactBucket?: string },
): string {
  if (checkpoint.url !== 'auto') return checkpoint.url;
  if (!scope.projectId || !scope.artifactBucket || !/^[a-zA-Z0-9.-]+$/.test(scope.artifactBucket)) {
    throw new Error('auto checkpoints require a project and configured artifact bucket');
  }
  return `s3://${scope.artifactBucket}/projects/${scope.projectId}/runs/${scope.workflowId}/checkpoints/${scope.task}/${index}/`;
}

export function checkpointSignature(checkpoint: NonNullable<TaskSpec['checkpoint']>[number]): string {
  return createHash('sha256').update(JSON.stringify({
    path: checkpoint.path, url: checkpoint.url, regex: checkpoint.regex ?? '',
  })).digest('hex');
}

export function checkpointPath(checkpoint: NonNullable<TaskSpec['checkpoint']>[number],
  scope: { outputPath: string; workflowId: string; task: string }): string {
  return checkpoint.path.replace(/\{\{\s*output\s*\}\}/g, scope.outputPath)
    .replace(/\{\{\s*workflow_id\s*\}\}/g, scope.workflowId)
    .replace(/\{\{\s*task_name\s*\}\}/g, scope.task);
}

export function checkpointSources(workflow: Workflow, task: RecoveryTask): CheckpointSource[] {
  const sources = [
    ...(task.attempts > 0 && task.attemptEpoch
      ? [{ workflowId: workflow.id, task: task.name, attempt: task.attempts, epoch: task.attemptEpoch }] : []),
    ...(task.checkpointRestoreSources ?? []),
  ];
  const unique = sources.filter((source, index) => sources.findIndex(other =>
    other.workflowId === source.workflowId && other.task === source.task &&
    other.attempt === source.attempt && other.epoch === source.epoch) === index);
  if (unique.length > 32) throw new Error('Checkpoint retry lineage exceeds the supported 32 attempts');
  return unique;
}
