import { expect, it, vi } from 'vitest';
import type { Workflow, Task } from '../store/types';
import type { Pod } from '../k8s/resources';
import type { AttemptSecret } from '../k8s/attempt-secrets';
import { injectedLogSecrets } from './log-secrets';
const wf = { id: 'run', projectId: 'p', namespace: 'team' } as Workflow;
const task = { name: 'train', attempts: 1, attemptEpoch: 'e' } as Task;
function fixture() {
  const name = 'wf-run-train-creds';
  const pod = { metadata: { name: 'pod', namespace: 'team', labels: { 'pai.aws/epoch': 'e', 'pai.aws/attempt': '1' },
    annotations: { 'pai.aws/attempt-secret-name': name, 'pai.aws/attempt-secret-uid': 'uid' } },
    spec: { containers: [{ name: 'main', image: 'x', env: [{ name: 'HF_TOKEN', valueFrom: { secretKeyRef: { name, key: 'HF_TOKEN' } } }] }] } } as Pod;
  const secret: AttemptSecret = { metadata: { name, namespace: 'team', uid: 'uid', labels: {
    'app.kubernetes.io/managed-by': 'physical-ai-dashboard', 'pai.aws/workflow-id': 'run', 'pai.aws/task': 'train',
    'pai.aws/project': 'p', 'pai.aws/attempt': '1', 'pai.aws/epoch': 'e' } }, type: 'Opaque', immutable: true,
    data: { HF_TOKEN: Buffer.from('exact-original-secret').toString('base64') } };
  return { pod, secret };
}
it('reads the exact immutable injected Secret by UID, including for an init-container log', async () => {
  const { pod, secret } = fixture(), read = vi.fn(async () => secret);
  expect(await injectedLogSecrets(wf, task, pod, 'pai-storage-prepare', read)).toEqual(['exact-original-secret']);
  expect(read).toHaveBeenCalledWith('team', 'wf-run-train-creds');
});
it('verifies the Secret against the pod\'s own attempt labels, not the mutable task record', async () => {
  // redactorFor passes {...task, attempts: target.attempt}; the store task is at a later attempt/epoch.
  const staleTask = { name: 'train', attempts: 1, attemptEpoch: 'e2' } as Task;
  const { pod, secret } = fixture();
  pod.metadata.labels!['pai.aws/epoch'] = 'e1';
  secret.metadata.labels!['pai.aws/epoch'] = 'e1';
  expect(await injectedLogSecrets(wf, staleTask, pod, 'main', async () => secret)).toEqual(['exact-original-secret']);
});
it('rejects replacement/mutable Secret values and arbitrary references without leaking values', async () => {
  const { pod, secret } = fixture();
  await expect(injectedLogSecrets(wf, task, pod, 'main', async () => ({ ...secret, immutable: false }))).rejects.toThrow('identity cannot be verified');
  await expect(injectedLogSecrets(wf, task, pod, 'main', async () => ({ ...secret, metadata: { ...secret.metadata, uid: 'replacement' } }))).rejects.toThrow('identity cannot be verified');
  pod.spec.containers[0].env![0].valueFrom = { secretKeyRef: { name: 'another-project', key: 'HF_TOKEN' } };
  const read = vi.fn(async () => secret);
  await expect(injectedLogSecrets(wf, task, pod, 'main', read)).rejects.toThrow('binding unavailable');
  expect(read).not.toHaveBeenCalled();
});
