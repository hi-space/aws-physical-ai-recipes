/** Backward-compatible facade; reliability logic lives in small workflow modules. */
import { randomBytes } from 'node:crypto';
import { GetParameterCommand } from '@aws-sdk/client-ssm';
import { ssm } from '../aws/clients';
import { config } from '../config';
import * as k8sRes from '../k8s/resources';
import { ensureAttemptSecret } from '../k8s/attempt-secrets';
import { workloadForJob, workloadState } from '../k8s/kueue';
import { notify } from '../notify';
import { getRepo } from '../store/repo';
import { TERMINAL_WF, type Workflow } from '../store/types';
import { mlflowUriFromConfig } from './compile';
import type { ControllerDeps, K8sPort } from './ports';
import { assertCredentialRef, submitWorkflowInternal, retryWorkflowInternal, type SubmitInput } from './submission';
import { reconcileWorkflowInternal, cancelWorkflowInternal, deleteWorkflowInternal } from './execution';
export type { ControllerDeps, K8sPort, JobSet, GroupRuntimeState, DeliveryContext } from './ports';
export type { SubmitInput } from './submission';
export { assertCredentialRef, CREDENTIAL_PREFIXES, newWorkflowId, resolveDatasetPath } from './submission';
export { deriveTaskPhase } from './status';
export const realK8s: K8sPort = {
  getJob: k8sRes.getJob,
  listPods: (ns, sel) => k8sRes.listPods(ns, sel),
  createJob: k8sRes.createJob,
  deleteJob: k8sRes.deleteJob,
  upsertConfigMap: k8sRes.upsertConfigMap,
  upsertSecret: k8sRes.upsertSecret,
  deleteByLabel: (ns, kind, sel) => k8sRes.deleteByLabel(ns, kind, sel),
  ensureNamespace: k8sRes.ensureNamespace,
  ensureFsxPvc: k8sRes.ensureFsxPvc,
  queueState: async (ns, name) => workloadState(await workloadForJob(ns, name))
};
export async function resolveCredentialFromSsm(ref: string): Promise<string> {
  assertCredentialRef(ref);
  const out = await ssm().send(new GetParameterCommand({
    Name: ref,
    WithDecryption: true
  }));
  if (out.Parameter?.Value === undefined) throw new Error(`SSM parameter ${ref} has no value`);
  return out.Parameter.Value;
}
let configured: Partial<Omit<ControllerDeps, 'repo' | 'now'>> = {};
/** Process bootstrap hook for parent's SFN/SQS/artifact/runtime adapters. */
export function configureController(overrides: Partial<Omit<ControllerDeps, 'repo' | 'now'>>): void {
  configured = {
    ...configured,
    ...overrides
  };
}
export function realDeps(): ControllerDeps {
  return {
    repo: getRepo(),
    k8s: { ...realK8s, ...(process.env.LOG_ARCHIVE_ENABLED === '1' ? { ensureAttemptSecret } : {}) },
    now: () => new Date(),
    notify,
    resolveCredential: resolveCredentialFromSsm,
    mlflowTrackingUri: mlflowUriFromConfig(),
    dataBucket: config().eks?.dataBucket,
    ...configured
  };
}
export const submitWorkflow = (input: SubmitInput, deps: ControllerDeps = realDeps()) => submitWorkflowInternal(input, deps);
export const cancelWorkflow = (id: string, actor: string, deps: ControllerDeps = realDeps()) => cancelWorkflowInternal(id, actor, deps);
export const retryWorkflow = (id: string, actor: string, deps: ControllerDeps = realDeps(), identity?: {
  ownerSubject: string;
}) => retryWorkflowInternal(id, actor, deps, identity);
export const deleteWorkflow = (id: string, deps: ControllerDeps = realDeps()) => deleteWorkflowInternal(id, deps);
export const reconcileWorkflow = (wf: Workflow, deps: ControllerDeps) => reconcileWorkflowInternal(wf, deps);
export interface ControllerStatus {
  running: boolean;
  holder: string;
  lastTick?: string;
  lastError?: string;
  ticks: number;
  leased: boolean;
}
const g = globalThis as unknown as {
  __paiController?: ControllerStatus;
  __paiControllerTimer?: NodeJS.Timeout;
  __paiControllerTick?: boolean;
};
const status: ControllerStatus = g.__paiController ??= {
  running: false,
  holder: `${process.pid}-${randomBytes(4).toString('hex')}`,
  ticks: 0,
  leased: false
};
export const controllerStatus = () => status;
export async function reconcileAll(deps: ControllerDeps = realDeps()): Promise<number> {
  let cursor: string | undefined,
    count = 0;
  do {
    const page = await deps.repo.listWorkflowsPage({
      limit: 200,
      cursor
    });
    cursor = page.cursor;
    for (const wf of page.items) {
      if (!TERMINAL_WF.has(wf.status)) count++;else if (!(await deps.repo.listOutbox(wf.id)).some(e => !e.deliveredAt)) continue;
      try {
        await reconcileWorkflowInternal(wf, deps);
      } catch (e) {
        console.error(`reconcile ${wf.id} failed`, e);
      }
    }
  } while (cursor);
  return count;
}
export function startController(intervalMs = 10_000): void {
  if (g.__paiControllerTimer) return;
  status.running = true;
  const tick = async () => {
    if (g.__paiControllerTick) return;
    g.__paiControllerTick = true;
    try {
      await reconcileAll(realDeps());
      status.ticks++;
      status.lastTick = new Date().toISOString();
      status.lastError = undefined;
    } catch (e) {
      status.lastError = e instanceof Error ? e.message : String(e);
    } finally {
      g.__paiControllerTick = false;
    }
  };
  g.__paiControllerTimer = setInterval(() => void tick(), intervalMs);
  void tick();
}
export function stopController(): void {
  if (g.__paiControllerTimer) clearInterval(g.__paiControllerTimer);
  g.__paiControllerTimer = undefined;
  status.running = false;
}
