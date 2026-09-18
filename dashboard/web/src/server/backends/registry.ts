import { createHash } from 'node:crypto';
import { z } from 'zod';
import { config, type DashboardConfig } from '../config';
import { HttpError } from '../errors';
import { requireRole, type Session } from '../auth/session';
import { getRepo, type Repo } from '../store/repo';

export const DEFAULT_BACKEND = 'default';
export const backendId = (id?: string) => id ?? DEFAULT_BACKEND;
export const backendCapabilities = ['api-eks-access', 'worker-eks-access', 'gateway-eks-access', 'worker-api-network',
  'gateway-api-network', 'pods-runtime-network', 'fsx-network', 'fsx-dra', 'home-s3-access', 'backend-s3-access', 'workload-isolation'] as const;
export interface Evidence { status: 'verified' | 'unknown'; checkedAt: string; expiresAt: string; reference: string }
export interface BackendProfile {
  id: string; configVersion: number; accountId: string; region: string; vpcId: string;
  eks: NonNullable<DashboardConfig['eks']>; namespaces: string[];
  evidence: Partial<Record<typeof backendCapabilities[number], Evidence>>;
}
export interface BackendBinding { backendId?: string; backendConfigHash?: string }
export interface Finding { code: string; message: string }
interface Revision {
  id: string; version: number; enabled: boolean; configVersion: number; configurationHash: string;
  createdAt: string; createdBy: string;
}
export interface BackendRecord extends Revision { status: 'READY' | 'UNREADY' | 'DISABLED'; findings: Finding[]; profile: BackendProfile }
export const backendRegistration = z.object({ id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/), expectedVersion: z.number().int().nonnegative(), enabled: z.boolean() }).strict();
const failure = (message: string) => new HttpError(409, message, 'backend_unavailable');
const hash = (profile: BackendProfile) => createHash('sha256').update(JSON.stringify({
  id: profile.id, configVersion: profile.configVersion, accountId: profile.accountId, region: profile.region, vpcId: profile.vpcId,
  // Evidence may be renewed without changing an immutable routing/storage binding.
  eks: Object.fromEntries(Object.entries(profile.eks).sort(([a], [b]) => a.localeCompare(b))),
  namespaces: [...profile.namespaces].sort(),
})).digest('hex');
const revKey = (version: number) => `REV#${String(version).padStart(10, '0')}`;
const dns = z.string().regex(/^[a-z0-9][a-z0-9.-]{0,252}$/);
const profileSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/).refine(id => id !== DEFAULT_BACKEND),
  configVersion: z.number().int().positive(), accountId: z.string().regex(/^\d{12}$/), region: z.string(),
  vpcId: z.string().regex(/^vpc-[a-z0-9]+$/),
  eks: z.object({
    eksClusterName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/), hyperPodClusterName: dns,
    dataBucket: dns, fsxFileSystemId: z.string().regex(/^fs-[a-z0-9]+$/), fsxDnsName: dns, fsxMountName: dns,
    logGroupPrefix: z.string().startsWith('/aws/'), ampWorkspaceId: z.string().optional(),
  }).strict(),
  namespaces: z.array(z.string().regex(/^hyperpod-ns-[a-z0-9-]+$/).max(63)).min(1).max(100),
  evidence: z.record(z.string(), z.object({ status: z.enum(['verified', 'unknown']), checkedAt: z.string(), expiresAt: z.string(), reference: z.string().min(1).max(1000) }).strict()).default({}),
}).strict();
/** Only deployment configuration can name a target. Admin API bodies contain no endpoints, roles or storage paths. */
export function configuredBackends(): BackendProfile[] {
  let raw: unknown;
  try { raw = JSON.parse(process.env.EKS_BACKENDS_JSON ?? '[]'); } catch { throw failure('Backend allowlist JSON is invalid'); }
  const parsed = z.array(profileSchema).max(30).safeParse(raw);
  if (!parsed.success) throw failure('Backend allowlist contains unsupported or invalid targets');
  const ids = parsed.data.map(p => p.id), clusters = parsed.data.map(p => p.eks.eksClusterName);
  if (new Set(ids).size !== ids.length || new Set(clusters).size !== clusters.length) throw failure('Backend identifiers and EKS clusters must be unique');
  return parsed.data;
}
export function configuredBackend(id: string): BackendProfile {
  const profile = configuredBackends().find(p => p.id === id);
  if (!profile) throw failure('Backend is not in the deployment allowlist');
  const home = config();
  if (profile.region !== home.region || !home.accountId || profile.accountId !== home.accountId) throw failure(`Only current-account ${home.region} EKS backends are supported`);
  if (!process.env.BACKEND_HOME_VPC_ID || profile.vpcId !== process.env.BACKEND_HOME_VPC_ID) throw failure('Backend must use the verified shared home VPC');
  if (profile.eks.eksClusterName === home.eks?.eksClusterName) throw failure('The home EKS cluster uses the default backend identity');
  return profile;
}
function capabilityFindings(profile: BackendProfile, now: Date): Finding[] {
  return backendCapabilities.flatMap(code => {
    const evidence = profile.evidence[code];
    return evidence?.status === 'verified' && evidence.reference && Number.isFinite(Date.parse(evidence.checkedAt)) &&
      Date.parse(evidence.checkedAt) <= now.getTime() && Date.parse(evidence.expiresAt) > now.getTime() &&
      Date.parse(evidence.expiresAt) - Date.parse(evidence.checkedAt) <= 7 * 86400_000
      ? [] : [{ code, message: `${code}: 배포 환경에서 확인한 유효한 접근·네트워크 증거가 필요합니다.` }];
  });
}
export async function registerBackend(session: Session, input: z.input<typeof backendRegistration>, repo: Repo = getRepo(), now = () => new Date()) {
  requireRole(session, 'admin');
  if (session.authMethod === 'token') throw new HttpError(403, 'API tokens cannot administer backends');
  const data = backendRegistration.parse(input), profile = configuredBackend(data.id);
  const item: Revision = { id: data.id, version: data.expectedVersion + 1, enabled: data.enabled, configVersion: profile.configVersion,
    configurationHash: hash(profile), createdAt: now().toISOString(), createdBy: session.subject ?? session.user };
  const ok = await repo.kv.transaction([
    { kind: 'put', item: { pk: `BACKEND#${data.id}`, sk: 'META', ...item },
      condition: data.expectedVersion ? { equals: { version: data.expectedVersion } } : { absent: true } },
    { kind: 'put', item: { pk: `BACKEND#${data.id}`, sk: revKey(item.version), ...item }, condition: { absent: true } },
  ]);
  if (!ok) throw failure('Backend registry changed; reload its version');
  return readBackend(data.id, repo, now);
}
export async function readBackend(id: string, repo: Repo = getRepo(), now = () => new Date()): Promise<BackendRecord> {
  const profile = configuredBackend(id), configurationHash = hash(profile);
  const stored = await repo.kv.get(`BACKEND#${id}`, 'META') as unknown as Revision | undefined;
  const findings = capabilityFindings(profile, now());
  if (!stored) findings.push({ code: 'unregistered', message: '관리자가 backend를 등록해야 합니다.' });
  if (stored && stored.configurationHash !== configurationHash) findings.push({ code: 'configuration_changed', message: '등록 버전과 배포 설정이 다릅니다. 기존 바인딩을 다른 대상으로 이동할 수 없습니다.' });
  const check = stored && await repo.kv.get(`BACKEND#${id}`, `CHECK#${stored.version}`);
  if (!check || check.configurationHash !== configurationHash || Number(check.expiresAt) <= now().getTime() || check.ok !== true) {
    findings.push({ code: 'capability_probe', message: '현재 등록 버전의 EKS API·RBAC·큐·FSx 검사가 필요합니다.' });
    if (Array.isArray(check?.findings)) findings.push(...check.findings as Finding[]);
  }
  return { ...(stored ?? { id, version: 0, configVersion: profile.configVersion, configurationHash, enabled: true, createdAt: '', createdBy: '' }),
    profile, status: stored?.enabled === false ? 'DISABLED' : findings.length ? 'UNREADY' : 'READY', findings };
}
export type BackendProbe = (profile: BackendProfile) => Promise<{ ok: boolean; findings: Finding[] }>;
export async function inspectBackend(session: Session, id: string, version: number, repo: Repo = getRepo(),
  probe: BackendProbe = async profile => (await import('./probe')).probeBackend(profile), now = () => new Date()) {
  requireRole(session, 'admin');
  if (session.authMethod === 'token') throw new HttpError(403, 'API tokens cannot inspect backend access');
  return checkRegisteredBackend(id, version, repo, probe, now);
}
async function checkRegisteredBackend(id: string, version: number, repo: Repo, probe: BackendProbe, now: () => Date) {
  const record = await readBackend(id, repo, now);
  if (!record.version || record.version !== version || record.configurationHash !== hash(record.profile)) throw failure('Backend revision/configuration changed');
  let result: Awaited<ReturnType<BackendProbe>>;
  try { result = await probe(record.profile); }
  catch { result = { ok: false, findings: [{ code: 'probe_failed', message: 'EKS 연결 또는 접근 검사에 실패했습니다. 성공으로 간주하지 않습니다.' }] }; }
  const ok = await repo.kv.transaction([
    { kind: 'check', pk: `BACKEND#${id}`, sk: 'META', condition: { equals: { version, configurationHash: record.configurationHash } } },
    { kind: 'put', item: { pk: `BACKEND#${id}`, sk: `CHECK#${version}`, configurationHash: record.configurationHash,
      checkedAt: now().toISOString(), expiresAt: now().getTime() + 15 * 60_000, ...result } },
  ]);
  if (!ok) throw failure('Backend changed while inspecting');
  return readBackend(id, repo, now);
}
/** Worker refreshes existing registrations only; never registers/enables a target or provisions resources. */
export async function refreshBackendChecks(repo: Repo = getRepo(), probe: BackendProbe = async profile => (await import('./probe')).probeBackend(profile), now = () => new Date()) {
  const results: Array<{ id: string; status: string }> = [];
  for (const profile of configuredBackends()) {
    try {
      const record = await readBackend(profile.id, repo, now);
      if (!record.version || !record.enabled) continue;
      const checked = await checkRegisteredBackend(profile.id, record.version, repo, probe, now);
      results.push({ id: profile.id, status: checked.status });
    } catch { results.push({ id: profile.id, status: 'UNREADY' }); }
  }
  return results;
}
export async function resolveBackend(binding: BackendBinding, repo: Repo = getRepo(), now = () => new Date(), mode: 'execute' | 'observe' = 'execute'): Promise<BackendRecord> {
  const record = await readBackend(backendId(binding.backendId), repo, now);
  if (!record.version || record.configurationHash !== hash(record.profile) || mode === 'execute' && record.status !== 'READY') throw new HttpError(409, 'Backend is not ready', 'backend_unavailable', { backendId: record.id, findings: record.findings });
  if (binding.backendConfigHash && binding.backendConfigHash !== record.configurationHash) throw failure('Immutable backend binding no longer matches the deployment configuration');
  return record;
}
