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
export interface ProjectRow { id: string; name: string; namespace: string; queue: string; backendId?: string; computeQuotaId: string; description?: string; myRole?: 'viewer' | 'researcher' | 'project-admin'; attachment: 'ATTACHED' | 'DETACHED' | 'UNKNOWN' }
export interface QuotaRow { ComputeQuotaId: string; Name?: string; Status?: string; ComputeQuotaTarget?: { TeamName?: string; FairShareWeight?: number }; detail?: { ComputeQuotaConfig?: { ComputeQuotaResources?: Array<{ InstanceType?: string; Count?: number }> } } }
const version = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const teamPattern = /^[a-z][a-z0-9-]{0,39}$/;
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
/** Quotas on a READY backend whose team is not yet adopted and whose namespace the backend allows. */
export function adoptableQuotas(registry: BackendRegistry | undefined, id: string, quotas: QuotaRow[] | undefined, projects: Array<{ computeQuotaId: string; id: string }>) {
  if (!backendAvailable(registry, id) || !quotas) return [];
  const allowed = id === 'default' ? undefined : registry?.backends.find(row => row.id === id)?.profile?.namespaces;
  return quotas.filter(q => {
    const team = q.ComputeQuotaTarget?.TeamName ?? '';
    return teamPattern.test(team) && (id === 'default' || allowed?.includes(`hyperpod-ns-${team}`)) &&
      !projects.some(p => p.computeQuotaId === q.ComputeQuotaId || p.id === team);
  });
}
export const quotaLabel = (q: QuotaRow) => `${q.ComputeQuotaTarget?.TeamName ?? '?'} · ${(q.detail?.ComputeQuotaConfig?.ComputeQuotaResources ?? []).map(r => `${r.InstanceType}×${r.Count}`).join(', ') || '—'} · fair-share ${q.ComputeQuotaTarget?.FairShareWeight ?? '—'}`;
export function registrationBody(row: BackendRow, enabled: boolean) {
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(row.id) || row.id === 'default' || !version(row.version) || !row.profile) throw new Error('Check deployable configuration and current version.');
  return { id: row.id, expectedVersion: row.version, enabled };
}
