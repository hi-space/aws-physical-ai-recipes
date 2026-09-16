import { createHash } from 'node:crypto';
import { z } from 'zod';
import { resolveProject, type Project } from '../auth/projects';
import { requireRole, type Session } from '../auth/session';
import { badRequest, forbidden, HttpError, notFound } from '../errors';
import { getRepo, type Repo } from '../store/repo';
import type { Item } from '../store/dynamo';
import { config } from '../config';
import type { WorkflowSpec } from '../workflow/schema';
import { inspectEcrImage, parsePrivateEcrImage, type ImageInspection, type ImageScope } from '../aws/ecr-inspection';
import { inspectHardware, instanceType, quantity, type HardwareNode, type HardwareSnapshot } from '../aws/hardware-inspection';

const idSchema = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
export const imageProfileInputSchema = z.object({
  id: idSchema, name: z.string().trim().min(1).max(100), image: z.string().min(1).max(600),
  expectedVersion: z.number().int().positive().optional(),
  requirements: z.object({
    minCpu: z.number().positive().max(1024).default(1),
    minMemoryMiB: z.number().positive().max(32 * 1024 * 1024).default(1024),
    minGpu: z.number().int().min(0).max(64).default(0),
    minGpuMemoryMiB: z.number().min(0).max(1024 * 1024).default(0),
    platforms: z.array(z.string().refine(v => !!instanceType(v), 'Use an EC2/HyperPod instance type')).max(30).default([]),
  }).strict().default({ minCpu: 1, minMemoryMiB: 1024, minGpu: 0, minGpuMemoryMiB: 0, platforms: [] }),
}).strict().refine(v => v.requirements.minGpu > 0 || v.requirements.minGpuMemoryMiB === 0, 'GPU memory requires a GPU count');
type ProfileInput = z.input<typeof imageProfileInputSchema>;
export interface ImageProfile {
  id: string; name: string; version: number; projectId: string; image: ImageInspection;
  requirements: z.output<typeof imageProfileInputSchema>['requirements'];
  approved: boolean; approvedBy?: string; createdBy: string; createdAt: string;
  source: 'admin' | 'deployment-env'; contentHash: string; enabled: boolean;
}
export interface ProfileFinding { code: string; severity: 'error' | 'warning' | 'unknown'; message: string; task?: string }
export interface TaskPreflight {
  task: string; profileId?: string; profileVersion?: number; image?: ImageInspection;
  hardwareCompatibility: 'compatible' | 'incompatible' | 'unknown'; compatibleNodes: string[];
  driver: 'unknown' | 'not-applicable'; modelAccess: 'unknown'; findings: ProfileFinding[];
}
export interface ImagePreflight {
  projectId: string; checkedAt: string; status: 'blocked' | 'needs-review';
  /** Values are full repository@sha256:... URIs, including an immutable index digest for multi-arch images. */
  resolvedImageDigests: Record<string, string>;
  tasks: TaskPreflight[]; findings: ProfileFinding[]; hardware?: HardwareSnapshot;
}
export interface ImageProfileDeps {
  repo: Repo; scope: ImageScope; now(): Date; inspectImage(image: string): Promise<ImageInspection>;
  hardware(): Promise<HardwareSnapshot>; environment: Record<string, string | undefined>;
}
const builtins: Record<string, string> = {
  mujoco: 'MUJOCO_IMAGE_URI', isaaclab: 'ISAACLAB_IMAGE_URI', ros2: 'ROS2_IMAGE_URI',
  groot: 'GROOT_RUNTIME_IMAGE_URI', openpi: 'OPENPI_IMAGE_URI', cosmos: 'COSMOS_IMAGE_URI',
  leisaac: 'LEISAAC_IMAGE_URI', workspace: 'WORKSPACE_IMAGE_URI', runtime: 'TASK_RUNTIME_IMAGE',
};
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const headKey = (projectId: string, id: string) => ({ pk: `PROJECT#${projectId}`, sk: `IMAGE_PROFILE#${id}` });
const versionKey = (projectId: string, id: string, version: number) => ({ pk: `PROJECT#${projectId}`, sk: `IMAGE_PROFILE_REV#${id}#${String(version).padStart(8, '0')}` });
const conflict = () => new HttpError(409, '이미지 프로필 버전이 변경되었습니다. 최신 버전을 확인하세요.', 'image_profile_conflict');
const asProfile = (item: Item, enabled: boolean): ImageProfile => {
  const { pk: _pk, sk: _sk, ...value } = item;
  return { ...value, enabled } as unknown as ImageProfile;
};
function defaults(): ImageProfileDeps {
  const c = config(), scope = { accountId: c.accountId, region: c.region };
  return { repo: getRepo(), scope, now: () => new Date(), inspectImage: image => inspectEcrImage(image, scope), hardware: () => inspectHardware(), environment: process.env };
}

export function imageProfilesService(session: Session, d: ImageProfileDeps = defaults()) {
  const authorize = async (project: Project, write = false) => {
    if (!session.subject) throw forbidden('Verified subject required');
    if (write) {
      requireRole(session, 'admin');
      if (session.authMethod === 'token' || session.tokenProjectId) throw forbidden('Image approval requires browser administrator login');
    }
    return resolveProject(session, project.id, d.repo);
  };
  async function get(id: string, project: Project, version?: number) {
    const p = await authorize(project);
    if (!idSchema.safeParse(id).success || version !== undefined && (!Number.isSafeInteger(version) || version < 1)) throw badRequest('Invalid image profile/version');
    const key = headKey(p.id, id), head = await d.repo.kv.get(key.pk, key.sk);
    if (!head) throw notFound('image profile');
    const vk = versionKey(p.id, id, version ?? Number(head.version));
    const row = await d.repo.kv.get(vk.pk, vk.sk);
    if (!row || row.projectId !== p.id) throw notFound('image profile version');
    await authorize(project);
    return asProfile(row, head.enabled !== false);
  }
  async function list(project: Project) {
    const p = await authorize(project);
    const heads = await d.repo.kv.query(`PROJECT#${p.id}`, 'IMAGE_PROFILE#');
    const profiles = await Promise.all(heads.map(head => get(String(head.id), p)));
    await authorize(project);
    return profiles;
  }
  async function save(input: ProfileInput, project: Project, approved: boolean) {
    const p = await authorize(project, true), parsed = imageProfileInputSchema.safeParse(input);
    if (!parsed.success) throw badRequest('이미지 프로필의 이름, 최소 자원 및 플랫폼을 확인하세요.');
    const value = parsed.data;
    parsePrivateEcrImage(value.image, d.scope);
    const image = await d.inspectImage(value.image);
    const requirements = { ...value.requirements, platforms: [...new Set(value.requirements.platforms.map(v => instanceType(v)!))].sort() };
    const contentHash = hash([value.name, image.requestedImage, image.digest, image.architectures, requirements, approved]);
    const key = headKey(p.id, value.id), old = await d.repo.kv.get(key.pk, key.sk);
    if (value.expectedVersion !== undefined && value.expectedVersion !== Number(old?.version ?? 0)) throw conflict();
    if (old?.contentHash === contentHash && old.enabled !== false) return get(value.id, p);
    if (old && value.expectedVersion === undefined) throw conflict();
    const version = Number(old?.version ?? 0) + 1;
    const profile: ImageProfile = {
      id: value.id, name: value.name, projectId: p.id, version, requirements, image, approved,
      ...(approved ? { approvedBy: session.subject } : {}), createdBy: session.subject!, createdAt: d.now().toISOString(),
      source: approved ? 'admin' : 'deployment-env', contentHash, enabled: true,
    };
    const current = await authorize(project, true);
    const saved = await d.repo.kv.transaction([
      { kind: 'check', pk: `PROJECT#${p.id}`, sk: 'META', condition: { equals: { namespace: current.namespace, updatedAt: current.updatedAt } } },
      { kind: 'put', item: { ...versionKey(p.id, value.id, version), ...profile }, condition: { absent: true } },
      { kind: 'put', item: { ...key, id: value.id, projectId: p.id, version, contentHash, enabled: true },
        condition: old ? { equals: { version: old.version, enabled: old.enabled } } : { absent: true } },
    ]);
    if (!saved) throw conflict();
    return profile;
  }
  async function disable(id: string, project: Project) {
    if (!idSchema.safeParse(id).success) throw badRequest('Invalid image profile');
    const p = await authorize(project, true), key = headKey(p.id, id);
    const old = await d.repo.kv.get(key.pk, key.sk);
    if (!old) throw notFound('image profile');
    if (!await d.repo.kv.transaction([{ kind: 'put', item: { ...old, enabled: false },
      condition: { equals: { version: old.version, enabled: old.enabled } } }])) throw conflict();
  }
  async function seed(project: Project) {
    const p = await authorize(project, true), profiles: ImageProfile[] = [], findings: ProfileFinding[] = [];
    for (const [name, variable] of Object.entries(builtins)) {
      const image = d.environment[variable], id = `builtin-${name}`;
      if (!image) continue;
      const key = headKey(p.id, id);
      if (await d.repo.kv.get(key.pk, key.sk)) continue; // Never revert an approved or disabled profile.
      try { profiles.push(await save({ id, name: `${name} deployment image`, image }, p, false)); }
      catch (error) { findings.push({ code: error instanceof HttpError ? error.code : 'image_inspection_failed', severity: 'error',
        message: `${variable}: 이미지 검사를 완료하지 못해 후보를 생성하지 않았습니다.` }); }
    }
    await authorize(project, true);
    return { profiles, findings };
  }
  async function preflight(spec: WorkflowSpec, project: Project): Promise<ImagePreflight> {
    const p = await authorize(project);
    if (!Array.isArray(spec.workflow?.tasks) || !spec.workflow.tasks.length || spec.workflow.tasks.length > 100) throw badRequest('Preflight requires 1–100 normalized tasks');
    const profiles = (await list(p)).filter(profile => profile.approved && profile.enabled);
    const tasks: TaskPreflight[] = [], resolvedImageDigests: Record<string, string> = Object.create(null);
    const inspections = new Map<string, Promise<ImageInspection>>();
    let hardware: HardwareSnapshot | undefined, probed = false;
    for (const task of spec.workflow.tasks) {
      if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(task.name) || tasks.some(t => t.task === task.name)) throw badRequest('Invalid or duplicate task name');
      const result: TaskPreflight = { task: task.name, hardwareCompatibility: 'unknown', compatibleNodes: [], driver: 'unknown', modelAccess: 'unknown', findings: [] };
      const add = (code: string, severity: ProfileFinding['severity'], message: string) => result.findings.push({ code, severity, message, task: task.name });
      tasks.push(result);
      try { parsePrivateEcrImage(task.image, d.scope); }
      catch (error) { add(error instanceof HttpError ? error.code : 'image_mirror_required', 'error', '현재 계정의 us-east-1 private ECR 이미지가 필요합니다.'); continue; }
      const matches = profiles.filter(profile => profile.image.requestedImage === task.image || profile.image.resolvedImage === task.image);
      if (matches.length !== 1) { add(matches.length ? 'image_profile_ambiguous' : 'image_profile_unapproved', 'error', '정확히 하나의 활성 관리자 승인 프로필이 필요합니다.'); continue; }
      const profile = matches[0];
      result.profileId = profile.id; result.profileVersion = profile.version;
      try {
        if (!inspections.has(task.image)) inspections.set(task.image, d.inspectImage(task.image));
        result.image = await inspections.get(task.image)!;
      }
      catch { add('image_inspection_failed', 'error', '현재 ECR 이미지 증거를 확인하지 못했습니다.'); continue; }
      if (result.image.digest !== profile.image.digest) { add('image_digest_changed', 'error', '승인 후 tag의 digest가 변경되었습니다. 새 버전 승인이 필요합니다.'); continue; }
      resolvedImageDigests[task.name] = result.image.resolvedImage;
      const resource = spec.workflow.resources[task.resource] ?? {};
      const requested = { cpu: quantity(resource.cpu, 'cpu'), memoryMiB: quantity(resource.memory, 'memory'), gpu: resource.gpu ?? 0 };
      const minimum = profile.requirements, requestedPlatform = task.platform ?? resource.platform;
      if (requested.cpu === undefined || requested.memoryMiB === undefined || requested.cpu < minimum.minCpu || requested.memoryMiB < minimum.minMemoryMiB || requested.gpu < minimum.minGpu) {
        add('profile_requirements', 'error', '작업의 CPU·메모리·GPU 요청이 승인된 최소 자원보다 작거나 누락됐습니다.');
      }
      const platform = instanceType(requestedPlatform);
      if (requestedPlatform && (!platform || minimum.platforms.length && !minimum.platforms.includes(platform))) add('profile_platform', 'error', '작업 플랫폼이 승인된 인스턴스 유형과 다릅니다.');
      if (!probed) { probed = true; try { hardware = await d.hardware(); } catch { /* Explicit unknown below. */ } }
      if (!hardware) add('hardware_probe_unavailable', 'unknown', '현재 노드와 EC2 사양을 조회하지 못했습니다.');
      else {
        const states = hardware.nodes.map(node => ({ node, state: fit(node, result.image!, minimum, requested, platform) }));
        result.compatibleNodes = states.filter(value => value.state === 'compatible').map(value => value.node.name);
        result.hardwareCompatibility = result.compatibleNodes.length ? 'compatible' : states.some(value => value.state === 'unknown') ? 'unknown' : 'incompatible';
        if (!hardware.nodes.length) add('no_current_nodes', 'error', '현재 검사할 노드가 없습니다. 용량을 생성하거나 변경하지 않았습니다.');
        else if (result.hardwareCompatibility === 'incompatible') add('hardware_incompatible', 'error', '현재 노드 중 아키텍처·플랫폼·CPU·메모리·GPU/VRAM 조건에 맞는 노드가 없습니다.');
        else if (result.hardwareCompatibility === 'unknown') add('hardware_evidence_missing', 'unknown', '노드 또는 EC2 사양에 필요한 증거가 누락됐습니다.');
        if (result.compatibleNodes.length) add('capacity_not_reserved', 'warning', '현재 allocatable/EC2 사양 비교입니다. 사용 중인 자원, taint, quota 또는 admission을 예약·보증하지 않습니다.');
      }
      result.driver = requested.gpu > 0 ? 'unknown' : 'not-applicable';
      if (requested.gpu > 0) {
        add('driver_unknown', 'unknown', 'GPU 드라이버·CUDA 호환성은 검사하지 않았습니다.');
        if (!minimum.minGpuMemoryMiB) add('vram_requirement_unknown', 'unknown', '이 프로필의 작업별 최소 VRAM 요구량이 지정되지 않았습니다.');
      }
      add('model_access_unknown', 'unknown', '모델·라이선스·데이터 접근과 실제 애플리케이션 실행은 검사하지 않았습니다.');
      if (task.parallelism > 1 || task.group) add('aggregate_capacity_unknown', 'unknown', '그룹/복제본 전체의 동시 배치 용량은 별도 확인이 필요합니다.');
    }
    for (const task of tasks) {
      if (!task.profileId || !resolvedImageDigests[task.task]) continue;
      const current = await get(task.profileId, p);
      if (!current.enabled || !current.approved || current.version !== task.profileVersion || current.image.digest !== task.image?.digest) {
        delete resolvedImageDigests[task.task];
        task.findings.push({ task: task.task, code: 'image_profile_changed', severity: 'error', message: '검사 중 승인 버전 또는 사용 상태가 변경됐습니다. 다시 검사하세요.' });
      }
    }
    await authorize(project); // Membership and approval may have changed during read-only probes.
    const findings = tasks.flatMap(task => task.findings);
    return { projectId: p.id, checkedAt: d.now().toISOString(), status: findings.some(f => f.severity === 'error') ? 'blocked' : 'needs-review',
      resolvedImageDigests, tasks, findings, ...(hardware ? { hardware } : {}) };
  }
  return { list, get, approve: (input: ProfileInput, project: Project) => save(input, project, true), disable, seed, preflight };
}

function fit(node: HardwareNode, image: ImageInspection, minimum: ImageProfile['requirements'],
  request: { cpu?: number; memoryMiB?: number; gpu: number }, platform?: string): TaskPreflight['hardwareCompatibility'] {
  if (!node.ready || !node.schedulable) return 'incompatible';
  if (platform && node.instanceType && platform !== node.instanceType || minimum.platforms.length && node.instanceType && !minimum.platforms.includes(node.instanceType)) return 'incompatible';
  if (!node.instanceType || !node.architecture || !node.catalog || request.cpu === undefined || request.memoryMiB === undefined) return 'unknown';
  if (!image.architectures.some(architecture => architecture === node.architecture)) return 'incompatible';
  const c = node.catalog, a = node.allocatable;
  if (!c.architectures.length || a.cpu === undefined || a.memoryMiB === undefined || c.cpu === undefined || c.memoryMiB === undefined) return 'unknown';
  if (!c.architectures.includes(node.architecture) || Math.min(a.cpu, c.cpu) < request.cpu || Math.min(a.memoryMiB, c.memoryMiB) < request.memoryMiB) return 'incompatible';
  if (request.gpu > 0) {
    if (a.gpu === undefined || c.gpuCount === undefined) return 'unknown';
    if (Math.min(a.gpu, c.gpuCount) < request.gpu) return 'incompatible';
    if (minimum.minGpuMemoryMiB && c.gpuMemoryMiB === undefined) return 'unknown';
    if (minimum.minGpuMemoryMiB && c.gpuMemoryMiB! < minimum.minGpuMemoryMiB) return 'incompatible';
  }
  return 'compatible';
}
