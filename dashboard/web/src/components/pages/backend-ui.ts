/** Browser DTOs only: no server registry/config code is bundled into the UI. */
export interface BackendRow {
  id: string; version?: number; enabled?: boolean; status: string; configurationHash?: string; configVersion?: number;
  createdAt?: string; createdBy?: string;
  findings: Array<{ code: string; message: string }>;
  profile?: {
    accountId?: string; region?: string; vpcId?: string; namespaces: string[];
    eks: { eksClusterName: string; hyperPodClusterName?: string; dataBucket?: string; fsxFileSystemId?: string };
  };
}
export interface BackendRegistry {
  default: { id: string; configured: boolean; clusterName?: string };
  backends: BackendRow[];
}
export interface BackendRevision { version: number; enabled: boolean; configVersion?: number; createdAt: string; createdBy: string }
export interface BackendQueue { namespace: string; name: string }
const version = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
export function backendStatus(status: string) {
  if (status === 'READY') return { label: 'READY · Available', tone: 'ok' as const };
  if (status === 'UNREADY') return { label: 'UNREADY · Preparation needed', tone: 'warn' as const };
  if (status === 'DISABLED') return { label: 'DISABLED · Disabled', tone: 'neutral' as const };
  return { label: 'Check status', tone: 'warn' as const };
}
export function backendAvailable(registry: BackendRegistry | undefined, id: string) {
  if (id === 'default') return registry?.default?.configured === true;
  const row = registry?.backends?.find(item => item.id === id);
  return !!row && row.status === 'READY' && row.enabled === true && version(row.version) && row.version > 0 && !!row.profile;
}
export function projectQueues(registry: BackendRegistry | undefined, id: string, queues: BackendQueue[] | undefined, projects: Array<{ namespace: string; backendId?: string }>) {
  if (!backendAvailable(registry, id) || !queues) return [];
  const allowed = id === 'default' ? undefined : registry?.backends.find(row => row.id === id)?.profile?.namespaces;
  const eligible = queues.filter(queue => /^hyperpod-ns-[a-z0-9][a-z0-9-]*$/.test(queue.namespace) &&
    queue.name === `${queue.namespace}-localqueue` && (id === 'default' || allowed?.includes(queue.namespace)) &&
    !projects.some(project => (project.backendId ?? 'default') === id && project.namespace === queue.namespace));
  return [...new Map(eligible.map(queue => [queue.namespace, queue])).values()];
}
export function registrationBody(row: BackendRow, enabled: boolean) {
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(row.id) || row.id === 'default' || !version(row.version) || !row.profile) throw new Error('Check deployable configuration and current version.');
  return { id: row.id, expectedVersion: row.version, enabled };
}
