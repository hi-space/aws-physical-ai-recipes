import { z } from 'zod';
import { badRequest, notFound } from '../errors';
import { getRepo, type Repo } from '../store/repo';
import { requireRole, type Session } from './session';
import { DEFAULT_BACKEND, backendId, resolveBackend } from '../backends/registry';
import { backendConfig, currentBackend } from '../backends/context';
import { listLocalQueues } from '../k8s/kueue';
import * as hp from '../aws/hyperpod';
import * as cognito from '../aws/cognito';
import { namespaceOf, projectIdPattern, projectItem, queueOf, getProject, listAllProjects, type Project } from './projects';

export const adoptInputSchema = z.object({
  computeQuotaId: z.string().min(1).max(128),
  backendId: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/).default(DEFAULT_BACKEND),
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(1000).optional(),
  credentialRefs: z.array(z.string().startsWith('/')).max(30).default([]),
}).strict();
export type AdoptInput = z.input<typeof adoptInputSchema>;

export interface QuotaSummary { id: string; teamName?: string; clusterArn?: string; status?: string }
export interface AdoptionDeps {
  repo: Repo;
  now(): Date;
  describeComputeQuota(id: string): Promise<QuotaSummary>;
  /** HyperPod cluster ARN of the backend the request runs on (runOnBackend context). */
  currentClusterArn(): Promise<string>;
  localQueueExists(namespace: string, name: string): Promise<boolean>;
  createProjectGroups(projectId: string): Promise<void>;
  deleteProjectGroups(projectId: string): Promise<void>;
  listComputeQuotas(clusterArn: string): Promise<Array<{ id: string; teamName?: string }>>;
}
export function productionAdoptionDeps(): AdoptionDeps {
  return {
    repo: getRepo(), now: () => new Date(),
    async describeComputeQuota(id) {
      const d = await hp.describeComputeQuota(id);
      return { id, teamName: d.ComputeQuotaTarget?.TeamName, clusterArn: d.ClusterArn, status: d.Status };
    },
    async currentClusterArn() {
      const name = backendConfig().eks?.hyperPodClusterName;
      if (!name) throw badRequest('HyperPod EKS cluster is not configured for this backend');
      const arn = (await hp.describeCluster(name)).ClusterArn;
      if (!arn) throw badRequest('HyperPod cluster ARN is unavailable');
      return arn;
    },
    async localQueueExists(namespace, name) {
      return (await listLocalQueues()).some((q) => q.metadata.namespace === namespace && q.metadata.name === name);
    },
    createProjectGroups: cognito.createProjectGroups,
    deleteProjectGroups: cognito.deleteProjectGroups,
    async listComputeQuotas(clusterArn) {
      return (await hp.listComputeQuotas(clusterArn)).map((q) => ({ id: q.ComputeQuotaId!, teamName: q.ComputeQuotaTarget?.TeamName }));
    },
  };
}

const namespaceOwnerKeys = (backend: string, namespace: string) => [
  { pk: `PROJECT_NAMESPACE#${backend}#${namespace}`, sk: 'OWNER' },
  ...(backend === DEFAULT_BACKEND ? [{ pk: `PROJECT_NAMESPACE#${namespace}`, sk: 'OWNER' }] : []),
];
const quotaOwnerKey = (computeQuotaId: string) => ({ pk: `PROJECT_QUOTA#${computeQuotaId}`, sk: 'OWNER' });

/** Adopt a task-governance Team (ComputeQuota) as a project. Platform admin only; runs inside runOnBackend(input). */
export async function adoptProject(session: Session, raw: AdoptInput, deps: AdoptionDeps = productionAdoptionDeps()): Promise<Project> {
  requireRole(session, 'admin');
  const parsed = adoptInputSchema.safeParse(raw);
  if (!parsed.success) throw badRequest('Invalid adoption request', { issues: parsed.error.issues });
  const input = parsed.data;
  let quota: QuotaSummary;
  try { quota = await deps.describeComputeQuota(input.computeQuotaId); }
  catch { throw badRequest('ComputeQuota를 찾을 수 없습니다. HyperPod 콘솔에서 팀(컴퓨트 할당)을 먼저 만드세요.'); }
  const id = quota.teamName ?? '';
  if (!projectIdPattern.test(id)) throw badRequest(`팀 이름 '${id}'이(가) 프로젝트 식별자 규칙(${projectIdPattern.source})에 맞지 않습니다.`);
  const clusterArn = await deps.currentClusterArn();
  if (quota.clusterArn !== clusterArn) throw badRequest('ComputeQuota belongs to a different HyperPod cluster than the selected backend');
  const namespace = namespaceOf({ id }), queue = queueOf({ id });
  if (input.backendId !== DEFAULT_BACKEND) {
    const backend = await resolveBackend({ backendId: input.backendId }, deps.repo, deps.now);
    if (!backend.profile.namespaces.includes(namespace)) throw badRequest('namespace is not allowed on this backend');
  }
  if (!(await deps.localQueueExists(namespace, queue))) throw badRequest('실행 가능한 큐가 아직 없습니다. 팀 네임스페이스와 LocalQueue가 준비된 뒤 다시 시도하세요.');
  const existing = await listAllProjects(deps.repo);
  if (existing.some((p) => p.id === id || p.computeQuotaId === input.computeQuotaId)) throw badRequest('이미 채택된 팀 또는 ComputeQuota입니다.');
  await deps.createProjectGroups(id);
  const now = deps.now().toISOString();
  const project: Project = {
    id, name: input.name ?? id, computeQuotaId: input.computeQuotaId, clusterArn, backendId: input.backendId,
    ...(currentBackend()?.configurationHash ? { backendConfigHash: currentBackend()!.configurationHash } : {}),
    namespace, queue, credentialRefs: input.credentialRefs, ...(input.description ? { description: input.description } : {}),
    createdAt: now, updatedAt: now,
  };
  const ok = await deps.repo.kv.transaction([
    { kind: 'put', item: projectItem(project), condition: { absent: true } },
    ...namespaceOwnerKeys(input.backendId, namespace).map((key) => ({ kind: 'put' as const, item: { ...key, projectId: id, backendId: input.backendId }, condition: { absent: true as const } })),
    { kind: 'put', item: { ...quotaOwnerKey(input.computeQuotaId), projectId: id }, condition: { absent: true } },
  ]);
  if (!ok) throw badRequest('이미 채택된 팀 또는 ComputeQuota입니다.');
  return project;
}

/** Remove the adoption record and groups. ComputeQuota, workflows, datasets and storage are left untouched. */
export async function deleteProject(session: Session, id: string, deps: AdoptionDeps = productionAdoptionDeps()): Promise<void> {
  requireRole(session, 'admin');
  const project = await getProject(id, deps.repo);
  if (!project) throw notFound('project not found');
  const backend = backendId(project.backendId);
  await deps.repo.kv.transaction([
    { kind: 'delete', pk: `PROJECT#${id}`, sk: 'META' },
    ...namespaceOwnerKeys(backend, project.namespace).map((key) => ({ kind: 'delete' as const, ...key })),
    { kind: 'delete', ...quotaOwnerKey(project.computeQuotaId) },
  ]);
  await deps.deleteProjectGroups(id);
}

export type Attachment = 'ATTACHED' | 'DETACHED' | 'UNKNOWN';
const ATTACHMENT_TTL_MS = 60_000;
const quotaCache = new Map<string, { at: number; quotas?: Array<{ id: string; teamName?: string }> }>();
export function resetAttachmentCacheForTests() { quotaCache.clear(); }
async function clusterQuotas(clusterArn: string, deps: AdoptionDeps) {
  const cached = quotaCache.get(clusterArn);
  const now = deps.now().getTime();
  if (cached && now - cached.at < ATTACHMENT_TTL_MS) return cached.quotas;
  let quotas: Array<{ id: string; teamName?: string }> | undefined;
  try { quotas = await deps.listComputeQuotas(clusterArn); } catch { quotas = undefined; }
  quotaCache.set(clusterArn, { at: now, quotas });
  return quotas;
}
/** Never called on the authorization hot path; list/detail routes only. */
export async function attachmentsFor(projects: Project[], deps: AdoptionDeps = productionAdoptionDeps()): Promise<Map<string, Attachment>> {
  const result = new Map<string, Attachment>();
  const byCluster = new Map<string, Project[]>();
  for (const p of projects) byCluster.set(p.clusterArn, [...(byCluster.get(p.clusterArn) ?? []), p]);
  for (const [clusterArn, group] of byCluster) {
    const quotas = await clusterQuotas(clusterArn, deps);
    for (const p of group) {
      result.set(p.id, quotas === undefined ? 'UNKNOWN' : quotas.some((q) => q.id === p.computeQuotaId && q.teamName === p.id) ? 'ATTACHED' : 'DETACHED');
    }
  }
  return result;
}
