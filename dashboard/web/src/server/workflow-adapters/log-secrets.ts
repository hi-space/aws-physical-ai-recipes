import { k8sJson } from '../k8s/client';
import type { AttemptSecret } from '../k8s/attempt-secrets';
import type { Pod } from '../k8s/resources';
import type { Workflow, Task } from '../store/types';
import { jobNameFor } from '../workflow/compile';

type EnvContainer = { name: string; env?: { valueFrom?: { secretKeyRef?: { name?: string; key?: string } } }[]; envFrom?: unknown[] };
export async function injectedLogSecrets(workflow: Workflow, task: Task, pod: Pod, _container: string,
  read: (namespace: string, name: string) => Promise<AttemptSecret> = (namespace, name) =>
    k8sJson(`/api/v1/namespaces/${namespace}/secrets/${name}`)): Promise<string[]> {
  const containers = [...pod.spec.containers, ...(pod.spec.initContainers ?? [])] as EnvContainer[];
  if (containers.some(container => container.envFrom?.length)) throw new Error('Unregistered log secret injection');
  const refs = containers.flatMap(container => container.env ?? []).flatMap(env => env.valueFrom?.secretKeyRef ? [env.valueFrom.secretKeyRef] : []);
  if (!refs.length) return [];
  const name = `${jobNameFor(workflow.id, task.name, task.attempts)}-creds`;
  if (refs.some(ref => ref.name !== name || !ref.key) || pod.metadata.namespace !== workflow.namespace ||
    pod.metadata.annotations?.['pai.aws/attempt-secret-name'] !== name ||
    !pod.metadata.annotations?.['pai.aws/attempt-secret-uid']) throw new Error('Original attempt Secret binding unavailable');
  const secret = await read(workflow.namespace, name);
  const labels = secret.metadata.labels;
  if (secret.immutable !== true || secret.type !== 'Opaque' || secret.metadata.name !== name ||
    secret.metadata.namespace !== workflow.namespace || secret.metadata.uid !== pod.metadata.annotations['pai.aws/attempt-secret-uid'] ||
    labels?.['app.kubernetes.io/managed-by'] !== 'physical-ai-dashboard' || labels['pai.aws/workflow-id'] !== workflow.id ||
    labels['pai.aws/task'] !== task.name || labels['pai.aws/epoch'] !== task.attemptEpoch ||
    labels['pai.aws/attempt'] !== String(task.attempts) || labels['pai.aws/project'] !== workflow.projectId) {
    throw new Error('Original attempt Secret identity cannot be verified');
  }
  return [...new Set(refs.map(ref => {
    const value = secret.data?.[ref.key!];
    if (typeof value !== 'string') throw new Error('Original injected secret value is unavailable');
    const bytes = Buffer.from(value, 'base64');
    if (bytes.toString('base64') !== value) throw new Error('Invalid original Secret encoding');
    return bytes.toString('utf8');
  }).filter(Boolean))];
}
