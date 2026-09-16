import { assertWritableNamespace, k8sGetOrNull, k8sJson } from './client';
import { managedLabels, type Meta } from './resources';

export interface AttemptSecret {
  metadata: Meta;
  type?: string;
  immutable?: boolean;
  data?: Record<string, string>;
}
export interface AttemptSecretPort {
  get(namespace: string, name: string): Promise<AttemptSecret | null>;
  create(namespace: string, value: unknown): Promise<AttemptSecret>;
}
const production: AttemptSecretPort = {
  get: (namespace, name) => k8sGetOrNull(`/api/v1/namespaces/${namespace}/secrets/${name}`),
  create: (namespace, value) => k8sJson(`/api/v1/namespaces/${namespace}/secrets`, { method: 'POST', body: value }),
};
function verified(secret: AttemptSecret, namespace: string, name: string, keys: string[], labels: Record<string, string>) {
  if (!secret.metadata.uid || secret.metadata.name !== name || secret.metadata.namespace !== namespace ||
    secret.type !== 'Opaque' || secret.immutable !== true ||
    Object.entries(managedLabels(labels)).some(([key, value]) => secret.metadata.labels?.[key] !== value) ||
    JSON.stringify(Object.keys(secret.data ?? {}).sort()) !== JSON.stringify([...keys].sort())) {
    throw new Error('Attempt Secret identity, immutability or key contract does not match');
  }
  return { uid: secret.metadata.uid };
}
/** Reconciliation reuses the original immutable values; rotating SSM affects a new attempt only. */
export async function ensureAttemptSecret(namespace: string, name: string, values: Record<string, string>, labels: Record<string, string>,
  port: AttemptSecretPort = production): Promise<{ uid: string }> {
  assertWritableNamespace(namespace);
  const existing = await port.get(namespace, name);
  if (existing) return verified(existing, namespace, name, Object.keys(values), labels);
  const body = { apiVersion: 'v1', kind: 'Secret', type: 'Opaque', immutable: true,
    metadata: { name, namespace, labels: managedLabels(labels) },
    data: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, Buffer.from(value).toString('base64')])) };
  try {
    return verified(await port.create(namespace, body), namespace, name, Object.keys(values), labels);
  } catch (error) {
    // The create may have committed despite a lost response. No UPDATE can change injected values.
    const observed = await port.get(namespace, name);
    if (observed) return verified(observed, namespace, name, Object.keys(values), labels);
    throw error;
  }
}
