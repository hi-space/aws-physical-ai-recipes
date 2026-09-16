import type { IncomingMessage, ServerResponse } from 'node:http';
import { getRepo } from '../store/repo';
import type { Workflow } from '../store/types';
import type { TaskSpec } from '../workflow/schema';
import type { ControllerDeps } from '../workflow/ports';
import { RuntimeBroker } from './broker';
import { createRuntimeHandler } from './http';
import { executionProfileChecks } from '../services/execution-profiles';
import { taskImagePolicyChecks } from '../services/profile-binding';
import { cleanupCheckpointUploads } from './upload-cleanup';
export { RuntimeBroker } from './broker';
export type { BrokerDeps } from './broker';
export { createRuntimeHandler } from './http';
export { guardChecks as runtimeGuardChecks, fenceKey as runtimeFenceKey } from './ledger';
export type { AuthContext } from './ledger';
export type { ObjectStorage } from './storage';
function realBroker() {
  return new RuntimeBroker({
    repo: getRepo(),
    now: () => new Date(),
    signingKey: process.env.RUNTIME_SIGNING_KEY ?? '',
    apiUrl: process.env.RUNTIME_API_URL ?? '',
    artifactBucket: process.env.DASHBOARD_ARTIFACT_BUCKET,
    validateTaskPolicy: async (workflow, task) => [
      ...await taskImagePolicyChecks(workflow, task),
      ...await executionProfileChecks(workflow, task),
    ],
  });
}
export function runtimeEnvironment(workflow: Workflow, task: TaskSpec, epoch: string, attempt: number): Record<string, string> {
  return realBroker().environment(workflow, task, epoch, attempt);
}
export function mintMetricsCapability(workflow: Workflow, task: TaskSpec, epoch: string, attempt: number): string {
  return realBroker().mintMetricsCapability(workflow, task, epoch, attempt);
}
export function validateMetricsCapability(token: string) {
  return realBroker().validateMetricsCapability(token);
}
export const groupRuntime: NonNullable<ControllerDeps['groupRuntime']> = {
  observe: (workflow, group, epoch, signal) => realBroker().observe(workflow, group, epoch, signal),
  fence: (workflow, group, epoch, signal) => realBroker().fence(workflow, group, epoch, signal)
};
export function validateRuntimeCapability(token: string) {
  return realBroker().authenticate(token);
}
export function cleanupRuntimeUploads(workflow: Workflow, context: { signal: AbortSignal; taskNames?: string[]; attempt?: number }) {
  return cleanupCheckpointUploads(realBroker().deps, workflow, context);
}
export async function handleRuntimeRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (!req.url?.startsWith('/runtime/')) return false;
  return createRuntimeHandler(realBroker())(req, res);
}
