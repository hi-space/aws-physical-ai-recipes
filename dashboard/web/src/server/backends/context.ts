import { AsyncLocalStorage } from 'node:async_hooks';
import { config, type DashboardConfig } from '../config';
import { getRepo, type Repo } from '../store/repo';
import { backendId, DEFAULT_BACKEND, resolveBackend, type BackendBinding, type BackendProfile } from './registry';
import { HttpError } from '../errors';

export interface BackendContext { id: string; configurationHash?: string; profile?: BackendProfile; ready: boolean }
const context = new AsyncLocalStorage<BackendContext>();
export const currentBackend = () => context.getStore();
/** Separate EKS-only view. DDB, Cognito, S3 archive, SFN and native SageMaker always use config(). */
export function backendConfig(): DashboardConfig {
  const home = config(), profile = currentBackend()?.profile;
  return profile ? { ...home, eks: profile.eks } : home;
}
export function assertBackendReady() {
  if (currentBackend()?.ready === false) throw new HttpError(409, 'Backend is unavailable for new workloads; existing resources may only be observed or cleaned up', 'backend_unavailable');
}
export async function runOnBackend<T>(binding: BackendBinding, operation: () => Promise<T>, repo: Repo = getRepo(), now = () => new Date(), mode: 'execute' | 'observe' = 'execute'): Promise<T> {
  const id = backendId(binding.backendId);
  if (id === DEFAULT_BACKEND) return context.run({ id, ready: true }, operation);
  const record = await resolveBackend(binding, repo, now, mode);
  return context.run({ id, profile: record.profile, configurationHash: record.configurationHash, ready: record.status === 'READY' }, operation);
}
/** Only the capability probe may use an unready allowlisted backend, for inspection without provisioning. */
export function inspectOnBackend<T>(profile: BackendProfile, operation: () => Promise<T>): Promise<T> {
  return context.run({ id: profile.id, profile, ready: false }, operation);
}
