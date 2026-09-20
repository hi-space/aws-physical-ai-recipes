import { z } from 'zod';
import { resolveProject, type Project } from '../auth/projects';
import { requireRole, type Session } from '../auth/session';
import { roleFromGroups } from '../auth/rbac';
import { currentUserAuthorization, type CurrentUserAuthorization } from '../aws/cognito';
import { backendId } from '../backends/registry';
import { runOnBackend } from '../backends/context';
import { badRequest, forbidden, HttpError, notFound } from '../errors';
import { k8sJson, SYSTEM_NAMESPACES } from '../k8s/client';
import { getRepo, type Repo } from '../store/repo';
import type { Workflow } from '../store/types';
import type { Write } from '../store/atomic';
import type { TaskSpec, WorkflowSpec } from '../workflow/schema';
import { parseWorkflowYaml } from '../workflow/template';
import { imageProfilesService } from './image-profiles';
import { executionHash, executionNodeBinding, executionPolicySchema, TRUSTED_NODE_LABEL, TRUSTED_NODE_TAINT,
  trustedTaskHash, approvedOutputNames, assertExecutionPin, type ExecutionProfilePin } from '../workflow/execution-profile-policy';

const idSchema = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
export const executionProfileInputSchema = z.object({
  id: idSchema, name: z.string().trim().min(1).max(100), expectedVersion: z.number().int().positive().optional(),
  yaml: z.string().min(1).max(256 * 1024), taskName: z.string().min(1).max(40),
  overrides: z.record(z.string(), z.string()).optional(), policy: executionPolicySchema,
  acknowledgeTrustBoundary: z.literal(true),
}).strict();
export interface ExecutionProfile extends ExecutionProfilePin {
  name: string; enabled: boolean; createdAt: string; approvedTask: TaskSpec;
}
export interface ExecutionNode {
  name: string; uid: string; ready: boolean; unschedulable?: boolean; labels: Record<string, string>;
  taints: { key: string; value?: string; effect: string }[];
  workloads: { namespace: string; phase: string; controllerKind?: string; projectId?: string; profile?: string }[];
}
export interface ExecutionProfileDeps {
  repo: Repo; now(): Date; currentUser(username: string): Promise<CurrentUserAuthorization>;
  inspectImage(task: TaskSpec, spec: WorkflowSpec, project: Project, session: Session): Promise<string>;
  nodes(): Promise<ExecutionNode[]>;
}
const pk = (project: string) => `PROJECT#${project}`;
const headSK = (id: string) => `EXECUTION_PROFILE#${id}`;
const revSK = (id: string, version: number) => `EXECUTION_PROFILE_REV#${id}#${String(version).padStart(8, '0')}`;
const changed = () => new HttpError(409, '실행 프로필의 승인·전용 노드·관리자 권한이 변경되었습니다. 다시 검토하세요.', 'execution_profile_changed');
function defaults(): ExecutionProfileDeps {
  return {
    repo: getRepo(), now: () => new Date(), currentUser: currentUserAuthorization,
    inspectImage: async (task, spec, project, session) => {
      const result = await imageProfilesService(session).preflight(spec, project);
      const checked = result.tasks.find(candidate => candidate.task === task.name);
      if (!checked?.profileId || !checked.profileVersion || checked.findings.some(f => f.severity === 'error') || !result.resolvedImageDigests[task.name]) {
        throw new HttpError(422, '먼저 작업의 이미지와 요구 자원을 승인하세요.', 'execution_image_unapproved');
      }
      return result.resolvedImageDigests[task.name];
    },
    nodes: async () => {
      type Node = { metadata: { name: string; uid: string; labels?: Record<string, string> };
        spec?: { unschedulable?: boolean; taints?: ExecutionNode['taints'] }; status?: { conditions?: { type: string; status: string }[] } };
      const nodes: Node[] = [];
      let cursor: string | undefined;
      const seen = new Set<string>();
      do {
        const query: URLSearchParams = new URLSearchParams({ limit: '200', ...(cursor ? { continue: cursor } : {}) });
        const page: { items: Node[]; metadata?: { continue?: string } } = await k8sJson(`/api/v1/nodes?${query}`);
        nodes.push(...page.items); cursor = page.metadata?.continue;
        if (cursor && seen.has(cursor)) throw new Error('Node inventory pagination did not progress');
        if (cursor) seen.add(cursor);
      } while (cursor);
      type Pod = { metadata: { namespace: string; labels?: Record<string, string>; annotations?: Record<string, string>;
        ownerReferences?: { kind: string; controller?: boolean }[] }; spec?: { nodeName?: string }; status?: { phase?: string } };
      const pods: Pod[] = [];
      cursor = undefined; seen.clear();
      do {
        const query: URLSearchParams = new URLSearchParams({ limit: '200', ...(cursor ? { continue: cursor } : {}) });
        const page: { items: Pod[]; metadata?: { continue?: string } } = await k8sJson(`/api/v1/pods?${query}`);
        pods.push(...page.items); cursor = page.metadata?.continue;
        if (cursor && seen.has(cursor)) throw new Error('Pod inventory pagination did not progress');
        if (cursor) seen.add(cursor);
      } while (cursor);
      return nodes.map(node => ({ name: node.metadata.name, uid: node.metadata.uid, labels: node.metadata.labels ?? {},
        taints: node.spec?.taints ?? [], unschedulable: node.spec?.unschedulable,
        ready: node.status?.conditions?.some(condition => condition.type === 'Ready' && condition.status === 'True') === true,
        workloads: pods.filter(pod => pod.spec?.nodeName === node.metadata.name).map(pod => ({
          namespace: pod.metadata.namespace, phase: pod.status?.phase ?? 'Unknown',
          controllerKind: pod.metadata.ownerReferences?.find(owner => owner.controller)?.kind,
          projectId: pod.metadata.labels?.['pai.aws/project'], profile: pod.metadata.annotations?.['pai.aws/execution-profile'],
        })),
      }));
    },
  };
}
async function currentAdmin(session: Session, d: ExecutionProfileDeps) {
  requireRole(session, 'admin');
  if (!session.subject || session.authMethod === 'token' || session.tokenProjectId) throw forbidden('Trusted execution requires browser administrator login');
  const user = await d.currentUser(session.user);
  if (!user.enabled || user.subject !== session.subject || roleFromGroups(user.groups) !== 'admin') throw forbidden('Current Cognito administrator membership is required');
}
async function trustedNodes(project: Project, id: string, d: ExecutionProfileDeps) {
  const binding = executionNodeBinding(project.id, id);
  const nodes = await runOnBackend(project, () => d.nodes(), d.repo);
  const matched = nodes.filter(node => node.labels[TRUSTED_NODE_LABEL] === binding);
  if (!matched.length || matched.some(node => !node.uid || !node.name || !node.ready || node.unschedulable ||
    node.labels['sagemaker.amazonaws.com/node-health-status'] !== 'Schedulable' ||
    !Array.isArray(node.workloads) || node.workloads.some(workload => !['Succeeded', 'Failed'].includes(workload.phase) &&
      !(SYSTEM_NAMESPACES.has(workload.namespace) && workload.controllerKind === 'DaemonSet') &&
      !(workload.namespace === project.namespace && workload.projectId === project.id && workload.profile?.startsWith(id + '@'))) ||
    !node.taints.some(taint => taint.key === TRUSTED_NODE_TAINT && taint.value === binding && taint.effect === 'NoSchedule'))) {
    throw new HttpError(422, '보호된 라벨과 전용 taint를 가진 Ready 노드가 필요합니다. 일반 연구 노드에서는 실행하지 않습니다.', 'trusted_nodes_unavailable');
  }
  return matched.map(({ name, uid }) => ({ name, uid })).sort((a, b) => a.name.localeCompare(b.name));
}
function pinFromProfile(profile: ExecutionProfile): ExecutionProfilePin {
  const { name: _name, enabled: _enabled, createdAt: _created, approvedTask: _task, ...pin } = profile;
  return pin;
}
export function executionProfilesService(session: Session, d: ExecutionProfileDeps = defaults()) {
  async function get(id: string, project: Project, version?: number) {
    const p = await resolveProject(session, project.id, d.repo);
    if (!idSchema.safeParse(id).success || version !== undefined && (!Number.isSafeInteger(version) || version < 1)) throw badRequest('Invalid execution profile/version');
    const head = await d.repo.kv.get(pk(p.id), headSK(id));
    if (!head) throw notFound('execution profile');
    const row = await d.repo.kv.get(pk(p.id), revSK(id, version ?? Number(head.version)));
    if (!row || row.projectId !== p.id) throw notFound('execution profile version');
    const { pk: _pk, sk: _sk, ...profile } = row;
    await resolveProject(session, p.id, d.repo);
    return { ...profile, enabled: head.enabled === true } as unknown as ExecutionProfile;
  }
  async function list(project: Project) {
    const p = await resolveProject(session, project.id, d.repo);
    const heads = await d.repo.kv.query(pk(p.id), 'EXECUTION_PROFILE#');
    return Promise.all(heads.map(head => get(String(head.id), p)));
  }
  async function approve(input: z.input<typeof executionProfileInputSchema>, project: Project) {
    await currentAdmin(session, d);
    const p = await resolveProject(session, project.id, d.repo);
    const parsed = executionProfileInputSchema.safeParse(input);
    if (!parsed.success) throw badRequest('승인할 작업, 마운트 경로와 전용 실행 경계 확인을 입력하세요.', { issues: parsed.error.issues });
    const value = parsed.data, spec = parseWorkflowYaml(value.yaml, value.overrides).spec;
    const task = spec.workflow.tasks.find(t => t.name === value.taskName);
    if (!task || task.volumes.length || task.inputs.some(i => 'dataset' in i && i.dataset.version === 'latest')) {
      throw badRequest('승인 대상 작업과 고정된 데이터셋 버전이 필요합니다. 직접 host volume 입력은 허용하지 않습니다.');
    }
    task.image = await runOnBackend(p, () => d.inspectImage(task, spec, p, session), d.repo);
    if (!/@sha256:[a-f0-9]{64}$/.test(task.image)) throw badRequest('Trusted execution requires a verified image digest');
    const nodes = await trustedNodes(p, value.id, d), nodeBinding = executionNodeBinding(p.id, value.id);
    const approvedTaskHash = trustedTaskHash(task, spec.workflow.resources[task.resource] ?? {}, p.namespace);
    const contentHash = executionHash({ name: value.name, projectId: p.id, namespace: p.namespace, backendId: backendId(p.backendId),
      approvedTaskHash, policy: value.policy, nodes, nodeBinding });
    const old = await d.repo.kv.get(pk(p.id), headSK(value.id));
    if (old && Number(old.version) !== value.expectedVersion || !old && value.expectedVersion !== undefined) throw changed();
    if (old?.contentHash === contentHash && old.enabled === true) return get(value.id, p);
    const version = Number(old?.version ?? 0) + 1;
    const profile: ExecutionProfile = { id: value.id, name: value.name, version, projectId: p.id, namespace: p.namespace,
      backendId: backendId(p.backendId), image: task.image, policy: value.policy, nodes, nodeBinding, approvedTaskHash,
      contentHash, approvedBy: session.subject!, createdAt: d.now().toISOString(), enabled: true, approvedTask: task };
    profile.outputNameTemplates = approvedOutputNames(task);
    await currentAdmin(session, d);
    const current = await resolveProject(session, p.id, d.repo);
    const saved = await d.repo.kv.transaction([
      // namespace is derived from the project id and never persisted, so updatedAt+backendId is the CAS token.
      { kind: 'check', pk: pk(p.id), sk: 'META', condition: { equals: { updatedAt: p.updatedAt, backendId: current.backendId } } },
      { kind: 'put', item: { pk: pk(p.id), sk: revSK(value.id, version), ...profile }, condition: { absent: true } },
      { kind: 'put', item: { pk: pk(p.id), sk: headSK(value.id), id: value.id, projectId: p.id, version, contentHash, enabled: true },
        condition: old ? { equals: { version: old.version, enabled: old.enabled } } : { absent: true } },
    ]);
    if (!saved) throw changed();
    return profile;
  }
  async function disable(id: string, project: Project, expectedVersion: number) {
    await currentAdmin(session, d);
    const p = await resolveProject(session, project.id, d.repo);
    const profile = await get(id, p);
    if (profile.version !== expectedVersion) throw changed();
    const key = { pk: pk(p.id), sk: headSK(id) }, head = await d.repo.kv.get(key.pk, key.sk);
    if (!head || !await d.repo.kv.transaction([{ kind: 'put', item: { ...head, enabled: false },
      condition: { equals: { version: expectedVersion, enabled: head.enabled } } }])) throw changed();
  }
  async function bind(spec: WorkflowSpec, project: Project): Promise<Record<string, ExecutionProfilePin>> {
    const wanted = spec.workflow.tasks.filter(task => task.executionProfile);
    if (!wanted.length) return {};
    await currentAdmin(session, d);
    const p = await resolveProject(session, project.id, d.repo), pins: Record<string, ExecutionProfilePin> = {};
    for (const task of wanted) {
      const ref = task.executionProfile!;
      const profile = await get(ref.id, p, ref.version), head = await d.repo.kv.get(pk(p.id), headSK(ref.id));
      if (!profile.enabled || head?.enabled !== true || head.version !== ref.version) throw changed();
      const pin = pinFromProfile(profile);
      try { assertExecutionPin(pin, task, spec.workflow.resources[task.resource] ?? {}, { projectId: p.id, namespace: p.namespace, backendId: p.backendId }); }
      catch { throw new HttpError(422, '작업 내용이나 이미지가 승인된 프로필과 다릅니다. 현재 작업으로 새 버전을 승인하세요.', 'execution_task_changed'); }
      if (executionHash(await trustedNodes(p, ref.id, d)) !== executionHash(profile.nodes)) throw changed();
      pins[task.name] = pin;
    }
    await currentAdmin(session, d);
    const current = await resolveProject(session, p.id, d.repo);
    if (current.namespace !== p.namespace || backendId(current.backendId) !== backendId(p.backendId)) throw changed();
    for (const pin of Object.values(pins)) {
      const head = await d.repo.kv.get(pk(p.id), headSK(pin.id));
      if (head?.enabled !== true || head.version !== pin.version || head.contentHash !== pin.contentHash) throw changed();
    }
    return pins;
  }
  return { get, list, approve, disable, bind };
}

/** Called immediately before Kubernetes create; queues and retries never extend approval authority. */
export async function executionProfileChecks(workflow: Workflow, task: TaskSpec, d: ExecutionProfileDeps = defaults()): Promise<Write[]> {
  if (!task.executionProfile && !workflow.executionProfilePins?.[task.name]) return [];
  const pin = workflow.executionProfilePins?.[task.name];
  try { assertExecutionPin(pin, task, workflow.spec.workflow.resources[task.resource] ?? {}, {
    projectId: workflow.projectId, namespace: workflow.namespace, backendId: workflow.backendId, workflowId: workflow.id,
  }); }
  catch { throw changed(); }
  const user = await d.currentUser(workflow.owner);
  if (!user.enabled || user.subject !== workflow.ownerSubject || roleFromGroups(user.groups) !== 'admin') throw changed();
  const session: Session = { user: user.username, subject: user.subject, email: user.email, role: 'admin', authMethod: 'alb' };
  const project = await resolveProject(session, pin.projectId, d.repo);
  if (project.namespace !== pin.namespace || backendId(project.backendId) !== pin.backendId) throw changed();
  const service = executionProfilesService(session, d);
  const profile = await service.get(pin.id, project, pin.version), head = await d.repo.kv.get(pk(pin.projectId), headSK(pin.id));
  if (!profile.enabled || head?.enabled !== true || head.version !== pin.version || profile.contentHash !== pin.contentHash ||
    executionHash(pinFromProfile(profile)) !== executionHash(pin)) throw changed();
  try {
    if (executionHash(await trustedNodes(project, pin.id, d)) !== executionHash(pin.nodes)) throw changed();
  } catch { throw changed(); }
  const finalUser = await d.currentUser(workflow.owner);
  if (!finalUser.enabled || finalUser.subject !== workflow.ownerSubject || roleFromGroups(finalUser.groups) !== 'admin') throw changed();
  const finalProject = await resolveProject(session, pin.projectId, d.repo);
  if (finalProject.namespace !== pin.namespace || backendId(finalProject.backendId) !== pin.backendId) throw changed();
  const finalHead = await d.repo.kv.get(pk(pin.projectId), headSK(pin.id));
  if (finalHead?.enabled !== true || finalHead.version !== pin.version || finalHead.contentHash !== pin.contentHash) throw changed();
  return [
    { kind: 'check', pk: pk(pin.projectId), sk: headSK(pin.id), condition: { equals: {
      enabled: true, version: pin.version, contentHash: pin.contentHash,
    } } },
    // namespace is derived from the project id and never persisted, so backendId+updatedAt is the CAS token.
    { kind: 'check', pk: pk(pin.projectId), sk: 'META', condition: { equals: {
      backendId: finalProject.backendId, updatedAt: finalProject.updatedAt,
    } } },
  ];
}
export async function validateExecutionProfile(workflow: Workflow, task: TaskSpec, d: ExecutionProfileDeps = defaults()): Promise<void> {
  await executionProfileChecks(workflow, task, d);
}
