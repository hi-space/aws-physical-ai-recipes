import { beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const inventory = vi.hoisted(() => vi.fn());
vi.mock('@/server/workflow-adapters/topology', () => ({ productionTopologyInventory: inventory }));
vi.mock('@/server/services/profile-binding', () => ({ profilesRequired: () => false, inspectWorkflowImages: vi.fn() }));
import { POST } from './validate/route';
import { Repo, setRepoForTests } from '@/server/store/repo';
import { MemoryKV } from '@/server/store/dynamo';
let repo: Repo;
const yaml = (key = 'zone') => `workflow:
  name: native-preview
  resources:
    cpu:
      cpu: 1
      memory: 1Gi
      topology: [{key: "${key}", group: shared, requirementType: required}]
  tasks:
    - name: train
      resource: cpu
      image: example/image
      command: [echo, ok]
`;
beforeEach(async () => {
  vi.stubEnv('TASK_RUNTIME_IMAGE', 'example/runtime');
  repo = new Repo(new MemoryKV()); setRepoForTests(repo);
  await repo.kv.put({ pk: 'PROJECT#a', sk: 'META', id: 'a', name: 'A', namespace: 'hyperpod-ns-a',
    queue: 'q-a', backendId: 'default', members: { subject: 'researcher' } });
  inventory.mockReset().mockImplementation(async () => ({
    namespace: 'hyperpod-ns-a', queue: 'q-a', revision: 'actual-registration', observedAt: new Date().toISOString(),
    levels: [{ key: 'zone', label: 'topology.k8s.aws/zone-id' }, { key: 'node', label: 'kubernetes.io/hostname' }],
    nodes: [{ name: 'node-a', uid: 'node-uid', labels: { 'topology.k8s.aws/zone-id': 'use1-az4', 'kubernetes.io/hostname': 'node-a', 'sagemaker.amazonaws.com/node-health-status': 'Schedulable' },
      ready: true, taints: [], available: { cpu: 8, memory: 16 * 1024 ** 3, pods: 20 } }],
  }));
});
async function validate(source: string) {
  return POST(new NextRequest('https://app.example/api/workflows/validate', { method: 'POST',
    headers: { origin: 'https://app.example', 'content-type': 'application/json', 'x-pai-user': 'user', 'x-pai-subject': 'subject', 'x-pai-role': 'researcher', 'x-pai-project': 'a' },
    body: JSON.stringify({ yaml: source }) }));
}
it('previews native placement from registered inventory without persisting a workflow or plan', async () => {
  const result = await (await validate(yaml())).json();
  expect(result.ok).toBe(true);
  expect(result.manifests[0].spec.template.spec.nodeSelector['topology.k8s.aws/zone-id']).toBe('use1-az4');
  expect(result.manifests[0].metadata.annotations['pai.aws/topology-plan']).toBeTruthy();
  expect(await repo.listWorkflows()).toEqual([]);
  expect(inventory.mock.calls[0][0]).toMatchObject({ projectId: 'a', backendId: 'default', namespace: 'hyperpod-ns-a' });
});
it('does not fabricate a rack hierarchy when only zone/hostname are registered', async () => {
  const result = await (await validate(yaml('rack'))).json();
  expect(result.ok).toBe(false);
  expect(result.error).toMatch(/unregistered topology key rack/);
});
