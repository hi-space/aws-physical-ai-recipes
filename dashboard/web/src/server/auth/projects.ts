import { z } from 'zod';
import { badRequest, forbidden, notFound } from '../errors';
import { getRepo, type Repo } from '../store/repo';
import { requireRole, type Session } from './session';
import { backendId, DEFAULT_BACKEND, resolveBackend } from '../backends/registry';
import { currentBackend } from '../backends/context';

export const projectInputSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
  name: z.string().min(1).max(100),
  namespace: z.string().regex(/^hyperpod-ns-[a-z0-9][a-z0-9-]*$/, 'A governed HyperPod team namespace is required'),
  backendId: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/).default(DEFAULT_BACKEND),
  members: z.record(z.string().min(1), z.enum(['viewer', 'researcher', 'project-admin'])).default({}),
  credentialRefs: z.array(z.string().startsWith('/')).max(30).default([]),
  description: z.string().max(1000).optional(),
});
export type ProjectRole = 'viewer' | 'researcher' | 'project-admin';
export interface Project {
  /** Missing on legacy projects means only the original default EKS backend. */
  backendId?: string;
  backendConfigHash?: string;
  id: string;
  name: string;
  namespace: string;
  queue: string;
  members: Record<string, ProjectRole>;
  credentialRefs: string[];
  description?: string;
  createdAt: string;
  updatedAt: string;
}
const principal = (session: Session) => session.subject ?? session.user;
const projectFromItem = (item: Record<string, unknown>) => {
  const { pk: _pk, sk: _sk, gsi1pk: _g1, gsi1sk: _g2, ...project } = item;
  return project as unknown as Project;
};

export async function listProjects(session: Session, repo: Repo = getRepo()): Promise<Project[]> {
  const indexed = await repo.kv.queryGsi1('TYPE#PROJECT');
  // GSIs discover projects, but permissions always use the strongly consistent META.
  const records = await Promise.all(indexed.map((item) => repo.kv.get(item.pk, 'META')));
  const projects = records.filter((item) => item !== undefined).map(projectFromItem);
  const visible = session.role === 'admin' ? projects : projects.filter((p) => Boolean(p.members[principal(session)]));
  return session.tokenProjectId ? visible.filter((project) => project.id === session.tokenProjectId) : visible;
}

export async function createProject(
  session: Session,
  input: z.input<typeof projectInputSchema>,
  repo: Repo = getRepo(),
): Promise<Project> {
  requireRole(session, 'admin');
  const result = projectInputSchema.safeParse(input);
  if (!result.success) throw badRequest('Invalid project namespace or membership', { issues: result.error.issues });
  const data = result.data;
  const backend = data.backendId === DEFAULT_BACKEND ? undefined : await resolveBackend(data, repo);
  if (backend && !backend.profile.namespaces.includes(data.namespace)) throw badRequest('namespace is not allowed on this backend');
  const all = await listProjects(session, repo);
  if (all.some((p) => backendId(p.backendId) === data.backendId && p.namespace === data.namespace && p.id !== data.id)) throw badRequest('namespace is already assigned to another project on this backend');
  const now = new Date().toISOString();
  const project: Project = { ...data, ...(backend ? { backendConfigHash: backend.configurationHash } : {}), queue: `${data.namespace}-localqueue`, createdAt: now, updatedAt: now };
  const created = await repo.kv.transaction([
    { kind: 'put', item: { pk: `PROJECT#${project.id}`, sk: 'META', gsi1pk: 'TYPE#PROJECT', gsi1sk: project.id, ...project }, condition: { absent: true } },
    { kind: 'put', item: { pk: `PROJECT_NAMESPACE#${data.backendId}#${project.namespace}`, sk: 'OWNER', projectId: project.id, backendId: data.backendId }, condition: { absent: true } },
    ...(data.backendId === DEFAULT_BACKEND ? [{ kind: 'put' as const, item: { pk: `PROJECT_NAMESPACE#${project.namespace}`, sk: 'OWNER', projectId: project.id }, condition: { absent: true as const } }] : []),
  ]);
  if (!created) throw badRequest('project or namespace is already assigned');
  return project;
}

export async function updateProjectMembers(session: Session, id: string, members: Record<string, ProjectRole>, repo: Repo = getRepo()) {
  const project = await resolveProject(session, id, repo, 'project-admin');
  const valid = projectInputSchema.shape.members.safeParse(members);
  if (!valid.success) throw badRequest('Invalid project members');
  const updated = { ...project, members: valid.data, updatedAt: new Date().toISOString() };
  await repo.kv.put({ pk: `PROJECT#${id}`, sk: 'META', gsi1pk: 'TYPE#PROJECT', gsi1sk: id, ...updated });
  return updated;
}

export async function ensureDefaultProject(session: Session, repo: Repo = getRepo()) {
  if (session.role !== 'admin') return;
  if ((await listProjects(session, repo)).length) return;
  try {
    await createProject(session, {
      id: 'workshop', name: 'Physical AI Workshop', namespace: 'hyperpod-ns-team-a',
      members: { [principal(session)]: 'project-admin' },
      description: '기존 HyperPod Team A 큐에 연결된 워크숍 프로젝트',
    }, repo);
  } catch (error) {
    if (!(await repo.kv.get('PROJECT#workshop', 'META'))) throw error;
  }
}

export async function resolveProject(
  session: Session,
  id?: string,
  repo: Repo = getRepo(),
  required: ProjectRole = 'viewer',
): Promise<Project> {
  if (session.tokenProjectId && id && id !== session.tokenProjectId) throw forbidden('Token is bound to another project');
  const direct = id ? await repo.kv.get(`PROJECT#${id}`, 'META') : undefined;
  const projects = direct ? [projectFromItem(direct)] : await listProjects(session, repo);
  let project = id ? projects.find((p) => p.id === id) : projects[0];
  if (!project && !id && session.role === 'admin') {
    const initial = await repo.kv.get('PROJECT#workshop', 'META');
    if (initial) project = projectFromItem(initial);
  }
  if (!project) throw forbidden('No access to the requested project. Ask a project administrator to add your Cognito subject.');
  if (session.role !== 'admin' && !project.members[principal(session)]) throw forbidden('No access to the requested project');
  const ranks = { viewer: 0, researcher: 1, 'project-admin': 2 };
  if (session.role !== 'admin' && ranks[project.members[principal(session)]] < ranks[required]) {
    throw forbidden(`This project requires ${required} permission`);
  }
  return project;
}

export async function requestProject(req: Request, session: Session, required: ProjectRole = 'viewer') {
  await ensureDefaultProject(session);
  if (session.tokenProjectId) return resolveProject(session, session.tokenProjectId, getRepo(), required);
  const cookie = /(?:^|;\s*)pai-project=([^;]+)/.exec(req.headers.get('cookie') ?? '')?.[1];
  let id = req.headers.get('x-pai-project') ?? undefined;
  if (!id && cookie) {
    try { id = decodeURIComponent(cookie); } catch { throw badRequest('Invalid project cookie'); }
  }
  return resolveProject(session, id, getRepo(), required);
}

export interface OwnedResource { owner?: string; ownerSubject?: string; projectId?: string }
export async function canReadResource(session: Session, resource: OwnedResource, repo: Repo = getRepo()) {
  if (session.tokenProjectId && resource.projectId !== session.tokenProjectId) return false;
  if (session.role === 'admin') return true;
  if (resource.projectId) {
    const item = await repo.kv.get(`PROJECT#${resource.projectId}`, 'META');
    return Boolean(item && projectFromItem(item).members[principal(session)]);
  }
  return resource.ownerSubject ? resource.ownerSubject === principal(session) : resource.owner === session.user;
}
export async function assertResourceAccess(session: Session, resource: OwnedResource | undefined, what = 'resource', write = false) {
  if (!resource || !(await canReadResource(session, resource))) throw notFound(what);
  if (write && resource.projectId) await resolveProject(session, resource.projectId, getRepo(), 'researcher');
}
export async function filterAccessible<T extends OwnedResource>(session: Session, resources: T[]): Promise<T[]> {
  if (session.tokenProjectId) resources = resources.filter((resource) => resource.projectId === session.tokenProjectId);
  if (session.role === 'admin') return resources;
  const projects = new Set((await listProjects(session)).map((p) => p.id));
  return resources.filter((r) => r.projectId
    ? projects.has(r.projectId)
    : r.ownerSubject ? r.ownerSubject === principal(session) : r.owner === session.user);
}
export async function assertNamespaceAccess(session: Session, namespace: string, write = false, selectedBackend = currentBackend()?.id ?? DEFAULT_BACKEND, repo: Repo = getRepo()) {
  if (/^(kube-|aws-|hyperpod-observability$|grafana$|kubeflow$|mpi-operator$)/.test(namespace)) {
    throw forbidden('System namespaces are not a researcher workspace');
  }
  if (session.role === 'admin') return;
  const project = (await listProjects(session, repo)).find((p) => p.namespace === namespace && backendId(p.backendId) === selectedBackend);
  if (!project) throw forbidden('No access to this project namespace');
  if (write && project.members[principal(session)] === 'viewer') throw forbidden('Project is read-only');
}
export function assertStorageScope(session: Session, project: Project, key: string) {
  if (key.includes('..') || key.includes('\\') || key.startsWith('/')) throw forbidden('Invalid storage path');
  if (session.role === 'admin') return;
  const prefixes = [`projects/${project.id}/`, `datasets/projects/${project.id}/`, `checkpoints/projects/${project.id}/`];
  if (!prefixes.some((prefix) => key.startsWith(prefix))) throw forbidden('Storage path belongs to another project');
}
