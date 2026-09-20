import { z } from 'zod';
import { badRequest, forbidden, notFound } from '../errors';
import { getRepo, type Repo } from '../store/repo';
import type { Item } from '../store/dynamo';
import type { Session } from './session';
import { PROJECT_ROLE_RANK, projectRoleFromGroups, type ProjectRole } from './rbac';
import { backendId, DEFAULT_BACKEND } from '../backends/registry';
import { currentBackend } from '../backends/context';

export type { ProjectRole } from './rbac';
// Ids ending in "-admin" are forbidden: "proj-<x>-admin" would be ambiguous between the admin
// group of "<x>" and the member group of "<x>-admin".
export const projectIdPattern = /^(?!.*-admin$)[a-z][a-z0-9-]{0,39}$/;

/**
 * A project is a thin adoption of a HyperPod task-governance Team (ComputeQuota). `id` is the TeamName;
 * `namespace`/`queue` are derived on read and never persisted; membership lives in Cognito groups.
 */
export interface Project {
  id: string;
  name: string;
  computeQuotaId: string;
  clusterArn: string;
  /** Missing on legacy projects means only the original default EKS backend. */
  backendId?: string;
  backendConfigHash?: string;
  namespace: string;
  queue: string;
  credentialRefs: string[];
  description?: string;
  createdAt: string;
  updatedAt: string;
}
export const namespaceOf = (p: Pick<Project, 'id'>) => `hyperpod-ns-${p.id}`;
export const queueOf = (p: Pick<Project, 'id'>) => `${namespaceOf(p)}-localqueue`;
export const projectIdFromNamespace = (namespace: string) => /^hyperpod-ns-((?!.*-admin$)[a-z][a-z0-9-]{0,39})$/.exec(namespace)?.[1];

export function projectFromItem(item: Record<string, unknown>): Project {
  const { pk: _pk, sk: _sk, gsi1pk: _g1, gsi1sk: _g2, namespace: _ns, queue: _q, members: _m, ...stored } = item;
  const base = stored as unknown as Omit<Project, 'namespace' | 'queue'>;
  return { ...base, namespace: namespaceOf(base), queue: queueOf(base) };
}
export function projectItem(project: Project): Item {
  const { namespace: _ns, queue: _q, ...stored } = project;
  return { pk: `PROJECT#${project.id}`, sk: 'META', gsi1pk: 'TYPE#PROJECT', gsi1sk: project.id, ...stored };
}

const principal = (session: Session) => session.subject ?? session.user;

/** The caller's role in a project. Platform admins act as project-admin; API tokens only see their bound project. */
export function memberRole(session: Session, project: Pick<Project, 'id'>): ProjectRole | undefined {
  if (session.tokenProjectId && session.tokenProjectId !== project.id) return undefined;
  if (session.role === 'admin') return 'project-admin';
  return projectRoleFromGroups(session.groups, project.id);
}
export const isMember = (session: Session, project: Pick<Project, 'id'>) => memberRole(session, project) !== undefined;
export const canWriteIn = (session: Session, project: Pick<Project, 'id'>) => { const role = memberRole(session, project); return role !== undefined && role !== 'viewer'; };
export const isProjectAdmin = (session: Session, project: Pick<Project, 'id'>) => memberRole(session, project) === 'project-admin';

export async function getProject(id: string, repo: Repo = getRepo()): Promise<Project | undefined> {
  if (!projectIdPattern.test(id)) return undefined;
  const item = await repo.kv.get(`PROJECT#${id}`, 'META');
  return item ? projectFromItem(item) : undefined;
}
export async function listAllProjects(repo: Repo = getRepo()): Promise<Project[]> {
  const indexed = await repo.kv.queryGsi1('TYPE#PROJECT');
  // GSIs discover projects, but authorization always uses the strongly consistent META.
  const records = await Promise.all(indexed.map((item) => repo.kv.get(item.pk, 'META')));
  return records.filter((item) => item !== undefined).map(projectFromItem).sort((a, b) => a.id.localeCompare(b.id));
}
export async function listProjects(session: Session, repo: Repo = getRepo()): Promise<Project[]> {
  return (await listAllProjects(repo)).filter((project) => isMember(session, project));
}

export async function resolveProject(session: Session, id?: string, repo: Repo = getRepo(), required: ProjectRole = 'viewer'): Promise<Project> {
  if (session.tokenProjectId && id && id !== session.tokenProjectId) throw forbidden('Token is bound to another project');
  const project = id ? await getProject(id, repo) : (await listProjects(session, repo))[0];
  const role = project ? memberRole(session, project) : undefined;
  if (!project || !role) throw forbidden('No access to the requested project. Ask a project administrator to add you to its Cognito group.');
  if (PROJECT_ROLE_RANK[role] < PROJECT_ROLE_RANK[required]) throw forbidden(`This project requires ${required} permission`);
  return project;
}

export async function requestProject(req: Request, session: Session, required: ProjectRole = 'viewer') {
  if (session.tokenProjectId) return resolveProject(session, session.tokenProjectId, getRepo(), required);
  const cookie = /(?:^|;\s*)pai-project=([^;]+)/.exec(req.headers.get('cookie') ?? '')?.[1];
  let id = req.headers.get('x-pai-project') ?? undefined;
  if (!id && cookie) {
    try { id = decodeURIComponent(cookie); } catch { throw badRequest('Invalid project cookie'); }
  }
  return resolveProject(session, id, getRepo(), required);
}

export const projectMetaSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(1000).optional(),
  credentialRefs: z.array(z.string().startsWith('/')).max(30).optional(),
}).strict();
export async function updateProjectMeta(session: Session, id: string, input: unknown, repo: Repo = getRepo()): Promise<Project> {
  const project = await resolveProject(session, id, repo, 'project-admin');
  const parsed = projectMetaSchema.safeParse(input);
  if (!parsed.success) throw badRequest('Invalid project metadata', { issues: parsed.error.issues });
  const updated: Project = { ...project, ...parsed.data, updatedAt: new Date().toISOString() };
  await repo.kv.put(projectItem(updated));
  return updated;
}

export interface OwnedResource { owner?: string; ownerSubject?: string; projectId?: string }
export async function canReadResource(session: Session, resource: OwnedResource, _repo: Repo = getRepo()): Promise<boolean> {
  if (session.tokenProjectId && resource.projectId !== session.tokenProjectId) return false;
  if (session.role === 'admin') return true;
  if (resource.projectId) return isMember(session, { id: resource.projectId });
  return resource.ownerSubject ? resource.ownerSubject === principal(session) : resource.owner === session.user;
}
export async function assertResourceAccess(session: Session, resource: OwnedResource | undefined, what = 'resource', write = false) {
  if (!resource || !(await canReadResource(session, resource))) throw notFound(what);
  if (write && resource.projectId) await resolveProject(session, resource.projectId, getRepo(), 'researcher');
}
export async function filterAccessible<T extends OwnedResource>(session: Session, resources: T[]): Promise<T[]> {
  const results = await Promise.all(resources.map((resource) => canReadResource(session, resource)));
  return resources.filter((_, index) => results[index]);
}
export async function assertNamespaceAccess(session: Session, namespace: string, write = false, selectedBackend = currentBackend()?.id ?? DEFAULT_BACKEND, repo: Repo = getRepo()) {
  if (/^(kube-|aws-|hyperpod-observability$|grafana$|kubeflow$|mpi-operator$)/.test(namespace)) {
    throw forbidden('System namespaces are not a researcher workspace');
  }
  if (session.role === 'admin') return;
  const id = projectIdFromNamespace(namespace);
  const role = id ? memberRole(session, { id }) : undefined;
  const project = id && role ? await getProject(id, repo) : undefined;
  if (!project || backendId(project.backendId) !== selectedBackend) throw forbidden('No access to this project namespace');
  if (write && role === 'viewer') throw forbidden('Project is read-only');
}
export function assertStorageScope(session: Session, project: Project, key: string) {
  if (key.includes('..') || key.includes('\\') || key.startsWith('/')) throw forbidden('Invalid storage path');
  if (session.role === 'admin') return;
  const prefixes = [`projects/${project.id}/`, `datasets/projects/${project.id}/`, `checkpoints/projects/${project.id}/`];
  if (!prefixes.some((prefix) => key.startsWith(prefix))) throw forbidden('Storage path belongs to another project');
}
