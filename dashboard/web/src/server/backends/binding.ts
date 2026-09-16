import { getRepo, type Repo } from '../store/repo';
import { HttpError } from '../errors';
import { backendId, DEFAULT_BACKEND, type BackendBinding } from './registry';

/** Compare persisted identities, never caller namespace/cluster headers. */
export async function assertWorkflowBackend(resource: BackendBinding & { projectId?: string }, repo: Repo = getRepo()) {
  const id = backendId(resource.backendId);
  if (!resource.projectId) {
    if (id !== DEFAULT_BACKEND) throw new HttpError(409, 'Additional backend requires a registered project');
    return;
  }
  const project = await repo.kv.get(`PROJECT#${resource.projectId}`, 'META');
  if (!project && id === DEFAULT_BACKEND) return; // existing legacy executor/test records
  if (!project || id !== backendId(project.backendId as string | undefined) ||
    resource.backendConfigHash !== project.backendConfigHash) throw new HttpError(409, 'Project and resource backend bindings disagree', 'backend_binding_mismatch');
}
