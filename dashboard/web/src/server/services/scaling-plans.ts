import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import * as hp from '../aws/hyperpod';
import { backendConfig, currentBackend } from '../backends/context';
import { getRepo, type Repo } from '../store/repo';
import { HttpError, badRequest, notFound } from '../errors';
import { k8sGetOrNull, k8sJson } from '../k8s/client';
import { listPods } from '../k8s/resources';
import { inspectActivity, scanScalingActivity, SCALE_ANNOTATION, type ActivityRows, type Blocker, type NodeTarget, type ScaleNode, type ScalePod } from './scaling-activity';
import type { ClusterNodeSummary, DescribeClusterResponse, BatchDeleteClusterNodesResponse } from '@aws-sdk/client-sagemaker';

export interface ScalingPolicy {
  version: number; backendId: string; cluster: string; group: string; minCount: number; baselineCount: number;
  backendConfigHash?: string; clusterArn?: string;
  protectedInstanceIds: string[];
  idleEnabled: boolean; idleMinutes: number; updatedAt: string; updatedBy: string;
}
export const policyInput = z.object({
  group: z.string().min(1).max(63), expectedVersion: z.number().int().nonnegative(),
  minCount: z.number().int().min(0).max(64), baselineCount: z.number().int().min(0).max(64),
  idleEnabled: z.boolean(), idleMinutes: z.number().int().min(1).max(1440),
  observedSpecHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const scalePlanInput = z.object({
  group: z.string().min(1).max(63), count: z.number().int().min(0).max(64),
  expectedCount: z.number().int().min(0).max(64), observedSpecHash: z.string().regex(/^[a-f0-9]{64}$/),
  mode: z.enum(['manual', 'idle']).default('manual'),
}).strict();
export interface ScalePlan {
  id: string; backendId: string; cluster: string; group: string; from: number; to: number;
  backendConfigHash?: string;
  mode: 'manual' | 'idle'; specHash: string; policyVersion: number; historyHash: string;
  observationHash: string;
  createdAt: string; expiresAt: number; createdBy: string; revision: number;
  status: 'PLANNED' | 'PREPARING' | 'ACCEPTED' | 'UNKNOWN' | 'SUCCEEDED' | 'PARTIAL' | 'FAILED' | 'BLOCKED';
  targets: NodeTarget[]; apiIssued: boolean; successful?: string[]; failed?: Array<{ NodeId?: string; Code?: string; Message?: string }>;
  message?: string; blockers?: Blocker[];
}
export interface ScalingDeps {
  repo: Repo; backendId: string; backendConfigHash?: string; clusterName?: string; now(): Date;
  describe(name: string): Promise<DescribeClusterResponse>; instances(name: string): Promise<ClusterNodeSummary[]>;
  nodes(): Promise<ScaleNode[]>; pods(): Promise<ScalePod[]>; activity(): Promise<ActivityRows>;
  canCordon(): Promise<boolean>;
  cordon(target: NodeTarget, operationId: string): Promise<void>;
  restore(target: NodeTarget, operationId: string): Promise<void>;
  increase(name: string, group: string, count: number, expected: number, hash: string): Promise<void>;
  remove(name: string, ids: string[], hash: string): Promise<BatchDeleteClusterNodesResponse>;
}
const pk = (d: ScalingDeps, cluster: string) => `SCALING#${d.backendId}#${cluster}`;
const policyKey = (group: string) => `POLICY#${group}`;
const planKey = (id: string) => `PLAN#${id}`;
const terminal = (status: ScalePlan['status']) => ['SUCCEEDED', 'PARTIAL', 'FAILED', 'BLOCKED'].includes(status);
const conflict = (message: string, details?: unknown) => new HttpError(409, message, 'scale_review_required', details);
const maxAge = 5 * 60_000;
async function nodePatch(target: NodeTarget, operationId: string, restore: boolean) {
  const path = `/api/v1/nodes/${encodeURIComponent(target.name)}`;
  const node = await k8sGetOrNull<ScaleNode>(path);
  if (!node) { if (restore) return; throw conflict('노드가 사라졌습니다.'); }
  if (node.metadata.uid !== target.uid) throw conflict('노드 UID가 바뀌었습니다.');
  if (restore && node.metadata.annotations?.[SCALE_ANNOTATION] !== operationId) return;
  if (!restore && (node.metadata.resourceVersion !== target.resourceVersion || node.spec?.unschedulable)) throw conflict('관측 후 노드 상태가 바뀌었습니다.');
  const annotations = { ...node.metadata.annotations };
  if (restore) delete annotations[SCALE_ANNOTATION]; else annotations[SCALE_ANNOTATION] = operationId;
  await k8sJson(path, { method: 'PATCH', headers: { 'content-type': 'application/json-patch+json' }, signal: AbortSignal.timeout(15_000),
    body: [
      { op: 'test', path: '/metadata/uid', value: target.uid },
      { op: 'test', path: '/metadata/resourceVersion', value: node.metadata.resourceVersion },
      { op: 'add', path: '/metadata/annotations', value: annotations },
      { op: 'add', path: '/spec/unschedulable', value: !restore },
    ],
  });
}
export function scalingDeps(): ScalingDeps {
  return {
    repo: getRepo(), backendId: currentBackend()?.id ?? 'default', backendConfigHash: currentBackend()?.configurationHash, clusterName: backendConfig().eks?.hyperPodClusterName,
    now: () => new Date(), describe: hp.describeCluster, instances: hp.listNodes,
    nodes: async () => {
      const out: ScaleNode[] = []; let next: string | undefined; const seen = new Set<string>();
      do {
        const response = await k8sJson<{ items: ScaleNode[]; metadata?: { continue?: string } }>(`/api/v1/nodes?limit=500${next ? `&continue=${encodeURIComponent(next)}` : ''}`);
        out.push(...response.items); next = response.metadata?.continue;
        if (next && (seen.has(next) || seen.size >= 100)) throw new Error('Incomplete node inventory');
        if (next) seen.add(next);
      } while (next);
      return out;
    }, pods: listPods, activity: scanScalingActivity,
    canCordon: async () => {
      const response = await k8sJson<{ status?: { allowed?: boolean } }>('/apis/authorization.k8s.io/v1/selfsubjectaccessreviews', {
        method: 'POST', body: { apiVersion: 'authorization.k8s.io/v1', kind: 'SelfSubjectAccessReview', spec: { resourceAttributes: { group: '', resource: 'nodes', verb: 'patch' } } },
        signal: AbortSignal.timeout(10_000),
      });
      return response.status?.allowed === true;
    },
    cordon: (node, id) => nodePatch(node, id, false), restore: (node, id) => nodePatch(node, id, true),
    increase: hp.scaleGroup, remove: hp.deleteIdleNodes,
  };
}
async function policy(cluster: string, group: string, d: ScalingDeps) {
  return await d.repo.kv.get(pk(d, cluster), policyKey(group)) as unknown as ScalingPolicy | undefined;
}
function structural(cluster: DescribeClusterResponse, group: string): Blocker[] {
  const target = cluster.InstanceGroups?.find(item => item.InstanceGroupName === group), blockers: Blocker[] = [];
  if (!cluster.ClusterArn || cluster.ClusterStatus !== 'InService' || !target?.InstanceType || target.Status !== 'InService' ||
    !Number.isSafeInteger(target?.CurrentCount) || !Number.isSafeInteger(target?.TargetCount) || target!.CurrentCount !== target!.TargetCount ||
    target!.CurrentCount! < 0 ||
    Object.values(target?.ActiveOperations ?? {}).some(value => value !== 0)) blockers.push({ code: 'cluster_changing', message: '클러스터·자원 풀이 안정된 InService 상태이거나 현재/목표 수가 일치하지 않습니다.' });
  if (target?.TrainingPlanArn || target?.InstanceRequirements || target?.CapacityRequirements || cluster.AutoScaling || target?.SlurmConfig) blockers.push({ code: 'unsupported_capacity', message: '예약·Spot·유연한 instance group·외부 autoscaler·Slurm 용량은 이 축소 정책에서 지원하지 않습니다.' });
  return blockers;
}
export async function scaleSnapshot(cluster: string, group: string, d = scalingDeps(), operationId?: string) {
  const description = await d.describe(cluster), target = description.InstanceGroups?.find(item => item.InstanceGroupName === group);
  if (!target) throw notFound('instance group');
  const specHash = hp.clusterSpecHash(description), savedPolicy = await policy(cluster, group, d), baseBlockers = structural(description, group);
  if (savedPolicy && (savedPolicy.backendConfigHash !== d.backendConfigHash || savedPolicy.clusterArn !== description.ClusterArn)) baseBlockers.push({ code: 'policy_binding_changed', message: '정책을 설정한 backend/클러스터와 현재 대상이 다릅니다. 자동 적용하지 않습니다.' });
  const reads = await Promise.allSettled([d.nodes(), d.pods(), d.instances(cluster), d.activity(), d.canCordon()]);
  let activity: ReturnType<typeof inspectActivity> = { blockers: [], targets: [], historyHash: '', observedAt: d.now().toISOString() };
  if (reads.some(r => r.status === 'rejected')) activity.blockers.push({ code: 'activity_unknown', message: '노드·Pod·워크플로·세션·결과 확정 기록 중 일부를 조회하지 못했습니다.' });
  else activity = inspectActivity(d.backendId, target, (reads[0] as PromiseFulfilledResult<ScaleNode[]>).value,
    (reads[1] as PromiseFulfilledResult<ScalePod[]>).value, (reads[2] as PromiseFulfilledResult<ClusterNodeSummary[]>).value,
    (reads[3] as PromiseFulfilledResult<ActivityRows>).value, d.now(), operationId, description.ClusterArn);
  if (reads[4].status !== 'fulfilled' || reads[4].value !== true) activity.blockers.push({ code: 'cordon_permission_unknown', message: '노드 사용 중지·복구 권한을 확인하지 못했습니다. 권한 없이 종료 요청을 보내지 않습니다.' });
  if (savedPolicy && (!Array.isArray(savedPolicy.protectedInstanceIds) || savedPolicy.protectedInstanceIds.length < Math.max(savedPolicy.minCount, savedPolicy.baselineCount) ||
    savedPolicy.protectedInstanceIds.some(id => !activity.targets.some(node => node.instanceId === id)))) baseBlockers.push({ code: 'baseline_identity_changed', message: '정책에서 보호한 기준 인스턴스를 확인하지 못했습니다. 기준을 다시 검토해야 합니다.' });
  if (cluster !== d.clusterName) activity.blockers.push({ code: 'backend_unobserved', message: '이 클러스터의 EKS 활동을 같은 backend에서 검증할 수 없습니다.' });
  const active = await d.repo.kv.get(pk(d, cluster), 'ACTIVE');
  if (active && active.id !== operationId) baseBlockers.push({ code: 'operation_pending', message: '이전에 요청한 용량 변경 결과를 먼저 확인하세요.', resources: [String(active.id)] });
  const quiet = [...baseBlockers, ...activity.blockers].length === 0;
  const trackerKey = `IDLE#${group}`, old = await d.repo.kv.get(pk(d, cluster), trackerKey);
  const fingerprint = createHash('sha256').update(JSON.stringify([specHash, activity.historyHash, savedPolicy?.version ?? 0, activity.targets.map(node => [node.instanceId, node.uid])])).digest('hex');
  const since = quiet && old?.fingerprint === fingerprint && typeof old.since === 'number' && old.since > 0 ? old.since : quiet ? d.now().getTime() : undefined;
  const updated = { pk: pk(d, cluster), sk: trackerKey, fingerprint, since: since ?? 0, revision: Number(old?.revision ?? 0) + 1 };
  // A read/plan samples idle evidence only; it never starts a capacity operation.
  await d.repo.kv.transaction([{ kind: 'put', item: updated, condition: old ? { equals: { revision: old.revision } } : { absent: true } }]);
  const attempted = await d.repo.kv.get(pk(d, cluster), `AUTO#${group}`);
  const alreadyAttempted = attempted?.observationHash === fingerprint && attempted.policyVersion === savedPolicy?.version;
  return { backendId: d.backendId, cluster, group, observedAt: d.now().toISOString(), specHash,
    currentCount: target.CurrentCount, targetCount: target.TargetCount, instanceType: target.InstanceType,
    policy: savedPolicy, floor: Math.max(savedPolicy?.minCount ?? 0, savedPolicy?.baselineCount ?? 0, target.MinCount ?? 0),
    idleSince: since === undefined ? undefined : new Date(since).toISOString(),
    idleEligible: !!savedPolicy?.idleEnabled && !alreadyAttempted && since !== undefined && d.now().getTime() - since >= savedPolicy.idleMinutes * 60_000,
    idleReviewRequired: alreadyAttempted, observationHash: fingerprint,
    structuralBlockers: baseBlockers, blockers: [...baseBlockers, ...activity.blockers, ...(!savedPolicy ? [{ code: 'policy_missing', message: '축소 전에 보호 최소치와 기준 노드 수를 관리자가 설정해야 합니다.' }] : [])],
    targets: activity.targets, historyHash: activity.historyHash, activeOperationId: active?.id as string | undefined };
}
export async function saveScalingPolicy(cluster: string, input: z.infer<typeof policyInput>, actor: string, d = scalingDeps()) {
  const description = await d.describe(cluster);
  if (hp.clusterSpecHash(description) !== input.observedSpecHash || structural(description, input.group).length) throw conflict('관측한 클러스터 설정이 바뀌었습니다.');
  const target = description.InstanceGroups!.find(g => g.InstanceGroupName === input.group)!;
  if (cluster !== d.clusterName || Math.max(input.minCount, input.baselineCount) > target.CurrentCount!) throw badRequest('보호 기준은 현재 확인한 EKS 자원 풀의 노드 수 이하여야 합니다.');
  if (await d.repo.kv.get(pk(d, cluster), 'ACTIVE')) throw conflict('용량 변경 결과를 먼저 확인하세요.');
  const members = (await d.instances(cluster)).filter(node => node.InstanceGroupName === input.group);
  const time = (node: ClusterNodeSummary) => node.LaunchTime instanceof Date ? node.LaunchTime.getTime() : Date.parse(String(node.LaunchTime));
  if (members.length !== target.CurrentCount || members.some(node => !node.InstanceId || !Number.isFinite(time(node))) || new Set(members.map(node => node.InstanceId)).size !== members.length) throw conflict('보호할 기준 인스턴스와 생성 시각을 확인하지 못했습니다.');
  const protectedInstanceIds = members.sort((a, b) => time(a) - time(b) || a.InstanceId!.localeCompare(b.InstanceId!))
    .slice(0, Math.max(input.minCount, input.baselineCount, target.MinCount ?? 0)).map(node => node.InstanceId!);
  if (hp.clusterSpecHash(await d.describe(cluster)) !== input.observedSpecHash) throw conflict('기준 인스턴스 확인 중 클러스터 설정이 바뀌었습니다.');
  const { expectedVersion, observedSpecHash: _h, ...values } = input;
  const saved: ScalingPolicy = { ...values, protectedInstanceIds, version: expectedVersion + 1, backendId: d.backendId, backendConfigHash: d.backendConfigHash, clusterArn: description.ClusterArn, cluster, updatedBy: actor, updatedAt: d.now().toISOString() };
  const ok = await d.repo.kv.transaction([{ kind: 'check', pk: pk(d, cluster), sk: 'ACTIVE', condition: { absent: true } }, { kind: 'put', item: {
    pk: pk(d, cluster), sk: policyKey(input.group), gsi1pk: 'TYPE#SCALING_POLICY', gsi1sk: `${d.backendId}#${cluster}#${input.group}`, ...saved },
    condition: expectedVersion ? { equals: { version: expectedVersion } } : { absent: true } }]);
  if (!ok) throw conflict('정책 버전이 동시에 바뀌었습니다.');
  return saved;
}
export async function planScale(cluster: string, input: z.infer<typeof scalePlanInput>, actor: string, d = scalingDeps()) {
  const snapshot = await scaleSnapshot(cluster, input.group, d);
  if (snapshot.specHash !== input.observedSpecHash || snapshot.targetCount !== input.expectedCount) throw conflict('노드 수 또는 전체 설정이 바뀌었습니다. 새 관측값으로 검토하세요.');
  const reducing = input.count < input.expectedCount;
  const blockers = [...(reducing ? snapshot.blockers : snapshot.structuralBlockers)];
  if (input.count === input.expectedCount) blockers.push({ code: 'no_change', message: '현재 목표와 같습니다.' });
  if (reducing && input.count < snapshot.floor) blockers.push({ code: 'protected_floor', message: `보호 최소치/기준 ${snapshot.floor}개 미만으로 줄일 수 없습니다.` });
  if (input.mode === 'idle' && (!reducing || !snapshot.idleEligible || input.count !== snapshot.floor)) blockers.push({ code: 'idle_not_eligible', message: '유휴 정책이 비활성 또는 관측 기간이 부족합니다. 정책은 보호 기준까지만 축소합니다.' });
  if (blockers.length) return { status: 'BLOCKED' as const, blockers, snapshot };
  const plan: ScalePlan = { id: randomUUID(), backendId: d.backendId, backendConfigHash: d.backendConfigHash, cluster, group: input.group,
    from: input.expectedCount, to: input.count, mode: input.mode, specHash: snapshot.specHash, policyVersion: snapshot.policy?.version ?? 0,
    historyHash: snapshot.historyHash, observationHash: snapshot.observationHash, createdAt: d.now().toISOString(), expiresAt: d.now().getTime() + maxAge, createdBy: actor,
    revision: 0, status: 'PLANNED', targets: reducing ? snapshot.targets.filter(node => !snapshot.policy!.protectedInstanceIds.includes(node.instanceId)).slice(0, input.expectedCount - input.count) : [], apiIssued: false };
  if (reducing && plan.targets.length !== plan.from - plan.to) throw conflict('삭제할 모든 노드의 식별자가 확인되지 않았습니다.');
  await d.repo.kv.put({ pk: pk(d, cluster), sk: planKey(plan.id), ...plan }, 'not_exists');
  return { status: 'PLANNED' as const, plan, blockers: [], snapshot };
}
interface Guard { check(): Promise<void>; holder: string; key: string }
async function locked<T>(cluster: string, d: ScalingDeps, operation: (guard: Guard) => Promise<T>) {
  const key = `SCALE#${d.backendId}#${cluster}`, holder = randomUUID();
  if (!await d.repo.acquireLease(key, holder, 120)) throw conflict('다른 관리자가 이 backend의 용량을 변경하고 있습니다.');
  let lost = false;
  const timer = setInterval(() => { void d.repo.acquireLease(key, holder, 120).then(ok => { lost ||= !ok; }).catch(() => { lost = true; }); }, 20_000);
  const guard: Guard = { holder, key, check: async () => {
    const lease = await d.repo.getLease(key);
    if (lost || lease?.holder !== holder || Number(lease.expires) <= Math.floor(d.now().getTime() / 1000)) throw conflict('용량 변경 lease가 만료되었습니다.');
  } };
  try { return await operation(guard); }
  finally { clearInterval(timer); await d.repo.kv.transaction([{ kind: 'delete', pk: 'SYS', sk: `LEASE#${key}`, condition: { equals: { holder } } }]); }
}
async function savePlan(plan: ScalePlan, changes: Partial<ScalePlan>, d: ScalingDeps, guard: Guard): Promise<ScalePlan> {
  await guard.check();
  const next = { ...plan, ...changes, revision: plan.revision + 1 };
  const ok = await d.repo.kv.transaction([
    { kind: 'check', pk: 'SYS', sk: `LEASE#${guard.key}`, condition: { equals: { holder: guard.holder }, after: { expires: Math.floor(d.now().getTime() / 1000) } } },
    { kind: 'put', item: { pk: pk(d, plan.cluster), sk: planKey(plan.id), ...next }, condition: { equals: { revision: plan.revision } } },
  ]);
  if (!ok) throw conflict('계획 상태가 동시에 바뀌었습니다.');
  return next;
}
async function releaseActive(plan: ScalePlan, d: ScalingDeps) {
  await d.repo.kv.transaction([{ kind: 'delete', pk: pk(d, plan.cluster), sk: 'ACTIVE', condition: { equals: { id: plan.id } } }]);
}
export async function executeScalePlan(cluster: string, id: string, actor: string, d = scalingDeps()) {
  return locked(cluster, d, async guard => {
    let plan = await d.repo.kv.get(pk(d, cluster), planKey(id)) as unknown as ScalePlan | undefined;
    if (!plan || plan.backendId !== d.backendId || plan.createdBy !== actor) throw notFound('scale plan');
    if (plan.status !== 'PLANNED') return plan; // replay observes the durable result, never repeats capacity mutation
    if (plan.expiresAt <= d.now().getTime()) throw new HttpError(410, '계획이 만료되었습니다.');
    const snapshot = await scaleSnapshot(cluster, plan.group, d);
    const reducing = plan.to < plan.from;
    const blockers = reducing ? snapshot.blockers : snapshot.structuralBlockers;
    if (snapshot.specHash !== plan.specHash || snapshot.targetCount !== plan.from || (snapshot.policy?.version ?? 0) !== plan.policyVersion ||
      reducing && (blockers.length || snapshot.historyHash !== plan.historyHash || plan.to < snapshot.floor || plan.mode === 'idle' && !snapshot.idleEligible) || !reducing && blockers.length) {
      return savePlan(plan, { status: 'BLOCKED', message: '정책·설정·활동이 바뀌었습니다. 계획을 다시 검토하세요.', blockers }, d, guard);
    }
    await guard.check();
    const preparing: ScalePlan = { ...plan, status: 'PREPARING', revision: plan.revision + 1 };
    const auto = plan.mode === 'idle' ? await d.repo.kv.get(pk(d, cluster), `AUTO#${plan.group}`) : undefined;
    const started = await d.repo.kv.transaction([
      { kind: 'check', pk: 'SYS', sk: `LEASE#${guard.key}`, condition: { equals: { holder: guard.holder }, after: { expires: Math.floor(d.now().getTime() / 1000) } } },
      { kind: 'put', item: { pk: pk(d, cluster), sk: planKey(plan.id), ...preparing }, condition: { equals: { revision: plan.revision, status: 'PLANNED' } } },
      { kind: 'put', item: { pk: pk(d, cluster), sk: 'ACTIVE', id: plan.id, backendId: d.backendId, backendConfigHash: d.backendConfigHash, cluster,
        gsi1pk: 'TYPE#SCALING_OPERATION', gsi1sk: plan.createdAt + '#' + plan.id }, condition: { absent: true } },
      ...(plan.mode === 'idle' ? [{ kind: 'put' as const, item: { pk: pk(d, cluster), sk: `AUTO#${plan.group}`, operationId: plan.id,
        policyVersion: plan.policyVersion, observationHash: plan.observationHash, revision: Number(auto?.revision ?? 0) + 1 },
        condition: auto ? { equals: { revision: auto.revision } } : { absent: true as const } }] : []),
    ]);
    if (!started) throw conflict('다른 용량 작업 또는 정책 변경과 경합했습니다.');
    plan = preparing;
    let cordonUncertain = false;
    try {
      for (const target of plan.targets) {
        await guard.check();
        try { await d.cordon(target, plan.id); } catch (error) { cordonUncertain = true; throw error; }
      }
      const fresh = await scaleSnapshot(cluster, plan.group, d, plan.id);
      const freshPolicy = fresh.policy?.version ?? 0;
      const ids = new Map(fresh.targets.map(node => [node.instanceId, node.uid]));
      if (plan.expiresAt <= d.now().getTime() || fresh.specHash !== plan.specHash || freshPolicy !== plan.policyVersion || fresh.targetCount !== plan.from ||
        reducing && (fresh.blockers.length || fresh.historyHash !== plan.historyHash || plan.targets.some(t => ids.get(t.instanceId) !== t.uid) || plan.to < fresh.floor)) throw conflict('최종 검사에서 활동 또는 용량 설정이 변경되었습니다.', fresh.blockers);
      await guard.check();
      plan = await savePlan(plan, { apiIssued: true }, d, guard);
      if (reducing) {
        const response = await d.remove(cluster, plan.targets.map(t => t.instanceId), plan.specHash);
        const successful = response.Successful ?? [], failed = response.Failed ?? [], returned = [...successful, ...failed.map(f => f.NodeId ?? '')];
        if (returned.length !== plan.targets.length || new Set(returned).size !== returned.length || returned.some(id => !plan!.targets.some(t => t.instanceId === id))) throw new Error('Node deletion response is incomplete or has unknown identities');
        plan = await savePlan(plan, { status: 'ACCEPTED', successful, failed, message: '응답을 수신했습니다. 실제 인스턴스 감소와 실패 노드 상태를 확인해야 합니다.' }, d, guard);
      } else {
        await d.increase(cluster, plan.group, plan.to, plan.from, plan.specHash);
        plan = await savePlan(plan, { status: 'ACCEPTED', message: '확장 요청을 접수했습니다. 완료 상태는 별도 확인이 필요합니다.' }, d, guard);
      }
      return plan;
    } catch (error) {
      const rejected = error instanceof HttpError && error.code === 'scale_spec_changed' ||
        ['AccessDeniedException', 'UnauthorizedOperation', 'ValidationException', 'ResourceNotFound', 'ResourceNotFoundException', 'ResourceLimitExceeded'].includes((error as Error)?.name);
      if (plan.apiIssued && rejected) {
        try { for (const target of plan.targets) await d.restore(target, plan.id); }
        catch { return savePlan(plan, { status: 'UNKNOWN', apiIssued: false, message: 'AWS가 요청을 거부했습니다. 자체 노드 사용 중지 복구를 확인하세요.' }, d, guard); }
        plan = await savePlan(plan, { status: 'FAILED', message: `용량 요청이 거부되어 노드 사용 중지를 복구했습니다: ${(error as Error).name}` }, d, guard);
        await releaseActive(plan, d); return plan;
      }
      if (plan.apiIssued || cordonUncertain) return savePlan(plan, { status: 'UNKNOWN', message: '요청 결과가 불명확합니다. 자동 재시도하지 않습니다. 실제 상태를 확인하세요.' }, d, guard);
      try { for (const target of plan.targets) await d.restore(target, plan.id); }
      catch { return savePlan(plan, { status: 'UNKNOWN', message: '용량은 변경하지 않았지만 사용 중지한 노드의 복구 상태를 확인해야 합니다.' }, d, guard); }
      plan = await savePlan(plan, { status: 'BLOCKED', message: error instanceof Error ? error.message : '활동을 확인하지 못해 중단했습니다.' }, d, guard);
      await releaseActive(plan, d); return plan;
    }
  });
}
export async function reconcileScale(cluster: string, id: string, d = scalingDeps()) {
  return locked(cluster, d, async guard => {
    let plan = await d.repo.kv.get(pk(d, cluster), planKey(id)) as unknown as ScalePlan | undefined;
    if (!plan) throw notFound('scale operation');
    if (terminal(plan.status)) { await releaseActive(plan, d); return plan; }
    if (plan.status === 'PLANNED') return plan;
    const [description, instances, nodes] = await Promise.all([d.describe(cluster), d.instances(cluster), d.nodes()]);
    const group = description.InstanceGroups?.find(g => g.InstanceGroupName === plan!.group);
    if (!group || structural(description, plan.group).length) return plan;
    if (!plan.apiIssued) {
      for (const target of plan.targets) await d.restore(target, plan.id);
      plan = await savePlan(plan, { status: 'BLOCKED', message: '용량 요청 전에 중단된 계획입니다. 자체 노드 사용 중지만 복구했습니다.' }, d, guard);
    } else if (plan.to > plan.from) {
      if (group.CurrentCount !== plan.to || group.TargetCount !== plan.to) return plan;
      plan = await savePlan(plan, { status: 'SUCCEEDED', message: '확장된 현재·목표 수를 확인했습니다.' }, d, guard);
    } else {
      // Unknown responses can be completed only if every selected identity is actually gone.
      const removed = plan.successful ?? plan.targets.map(t => t.instanceId);
      if (removed.some(id => instances.some(i => i.InstanceId === id) || nodes.some(n => plan!.targets.some(t => t.instanceId === id && t.uid === n.metadata.uid)))) return plan;
      if (group.CurrentCount !== plan.from - removed.length || group.TargetCount !== group.CurrentCount) return plan;
      for (const target of plan.targets.filter(t => plan!.failed?.some(f => f.NodeId === t.instanceId))) await d.restore(target, plan.id);
      plan = await savePlan(plan, { status: !removed.length ? 'FAILED' : plan.failed?.length ? 'PARTIAL' : 'SUCCEEDED',
        message: plan.failed?.length ? '부분 결과를 확인했습니다. 실패한 노드는 새 검토 없이 다시 삭제하지 않습니다.' : '선택한 노드가 제거되고 현재·목표 수가 일치함을 확인했습니다.' }, d, guard);
    }
    await releaseActive(plan, d);
    return plan;
  });
}
