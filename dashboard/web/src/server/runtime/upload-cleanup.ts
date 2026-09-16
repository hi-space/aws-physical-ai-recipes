import type { Workflow } from '../store/types';
import { HttpError } from '../errors';
import type { BrokerDeps } from './broker';
import { CheckpointService } from './uploads';
import { activeUploads } from './upload-registry';

/** Parent controller wiring: invoke during cancel/failure/retry cleanup.
 * Registry bounds discovery; committed snapshots and unrelated attempts are retained.
 * False means reconciliation/lease cleanup is still pending, never "clean enough". */
export async function cleanupCheckpointUploads(deps: BrokerDeps, workflow: Workflow, context: {
  signal: AbortSignal; taskNames?: string[]; attempt?: number;
}): Promise<boolean> {
  const service = new CheckpointService(deps, async () => { throw new HttpError(403, 'Operator cleanup cannot publish'); });
  const tasks = await deps.repo.listTasks(workflow.id);
  for (const task of tasks) {
    if (context.taskNames && !context.taskNames.includes(task.name) || context.attempt !== undefined && task.attempts !== context.attempt || !task.attemptEpoch) continue;
    for (const id of await activeUploads(deps, workflow.id, task.attemptEpoch, task.name)) {
      context.signal.throwIfAborted();
      try {
        await service.files.cleanup(workflow.id, task.attemptEpoch, id, workflow.projectId ?? 'legacy', task.name, task.attempts, context.signal);
      } catch (error) {
        if (error instanceof HttpError && error.status === 409) return false;
        throw error;
      }
    }
  }
  return true;
}
