import { describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ webhook: [] as string[] }));
vi.mock('../services/webhooks', () => ({ enqueueWorkflowWebhook: async (wf: { id: string }) => { calls.webhook.push(wf.id); } }));
vi.mock('../store/repo', () => ({ getRepo: () => ({ getWorkflow: async (id: string) => ({ id, status: 'SUCCEEDED' }) }) }));
vi.mock('../workflow/controller', () => ({ realDeps: () => ({ repo: {}, k8s: {}, now: () => new Date() }) }));
vi.mock('./artifacts', () => ({ artifactPublisher: {}, cancelArtifactCollectors: async () => true }));
vi.mock('../runtime', () => ({ runtimeEnvironment: () => ({}), groupRuntime: {}, mintMetricsCapability: () => '', cleanupRuntimeUploads: async () => undefined }));
vi.mock('../k8s/resources', () => ({ getJobSet: vi.fn(), createJobSet: vi.fn(), deleteJobSet: vi.fn() }));
vi.mock('../services/profile-binding', () => ({ validateTaskImagePolicy: async () => undefined }));
vi.mock('../services/execution-profiles', () => ({ validateExecutionProfile: async () => undefined }));
vi.mock('./topology', () => ({ productionTopologyInventory: {} }));

describe('productionControllerDeps', () => {
  it('completes a workflow by enqueuing its webhook only', async () => {
    const { productionControllerDeps } = await import('./dependencies');
    const deps = productionControllerDeps();
    expect('dispatchWorkflow' in deps).toBe(false);
    await deps.completeWorkflow!({ id: 'wf-1' } as never, { idempotencyKey: 'k', signal: new AbortController().signal });
    expect(calls.webhook).toEqual(['wf-1']);
  });
});
