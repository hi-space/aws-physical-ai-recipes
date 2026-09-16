import type { Workflow, Task } from '../store/types';
import type { Item } from '../store/dynamo';
import { getRepo, type Repo } from '../store/repo';
import { rateIsFresh, readRates, type ComputeRate, type RateSnapshot } from '../aws/hyperpod-rates';
import { TERMINAL_TASK, TERMINAL_WF } from '../store/types';
import { config } from '../config';
import type { Session } from '../auth/session';
import { canReadResource, resolveProject } from '../auth/projects';
import { notFound } from '../errors';

export interface UsageIssue { code: string; message: string; task?: string }
export interface TaskUsage {
  name: string; platform?: string; attemptsObserved: number; attemptsExpected: number; replicaHours: number;
  cpuHours: number | null; gpuHours: number | null; estimatedUsd: number | null; dedicatedInstanceUsd: number | null;
  knownCpuHours: number; knownGpuHours: number; knownEstimatedUsd: number;
  timingBasis: 'runtime-receipts' | 'task-observation' | 'not-started' | 'unknown'; rate?: ComputeRate;
}
const finiteTime = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : undefined;
const round = (value: number) => Math.round(value * 1e8) / 1e8;
function cpu(value: unknown) {
  const m = /^(\d+(?:\.\d+)?)(m)?$/.exec(String(value));
  return m ? Number(m[1]) / (m[2] ? 1000 : 1) : undefined;
}
const validGpu = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;

export function estimateRunUsage(workflow: Workflow, tasks: Task[], runtime: Item[], rates: RateSnapshot, now: Date, region: string) {
  const issues: UsageIssue[] = [];
  const fresh = rateIsFresh(rates, now);
  if (!fresh) issues.push({ code: 'stale_rates', message: '단가 조회 후 30일이 지났거나 조회 시각이 유효하지 않습니다. 금액은 확인할 수 없습니다.' });
  const add = (task: string, code: string, message: string) => { if (!issues.some(i => i.task === task && i.code === code)) issues.push({ task, code, message }); };
  const results: TaskUsage[] = workflow.spec.workflow.tasks.map(spec => {
    const ledger = tasks.find(t => t.name === spec.name);
    const resource = workflow.spec.workflow.resources[spec.resource];
    const requestedCpu = cpu(resource?.cpu), requestedGpu = resource?.gpu ?? 0;
    const platform = spec.platform ?? resource?.platform;
    const rate = rates.rates.find(r => r.instanceType === platform && r.region === region);
    let hours = 0, timingComplete = true, attemptsObserved = 0, basis: TaskUsage['timingBasis'] = 'unknown';
    const attemptsExpected = ledger?.attempts ?? 0;
    const members = runtime.filter(row => row.sk.startsWith('RUNTIME#') && row.sk.split('#')[2] === 'MEMBER' && row.task === spec.name);
    const epochs = [...new Set(members.map(row => row.sk.split('#')[1]))];
    const interval = (start: unknown, finish: unknown, multiplier: number) => {
      const a = finiteTime(start), b = finiteTime(finish);
      if (a === undefined || b === undefined || b < a || b > now.getTime() || a > now.getTime()) { timingComplete = false; return; }
      hours += (b - a) / 3600_000 * multiplier;
    };
    if (!ledger || !Number.isSafeInteger(ledger.attempts) || ledger.attempts < 0 || ledger.replicas !== spec.parallelism) {
      timingComplete = false;
      add(spec.name, 'missing_ledger', '작업의 실행 횟수·replica 기록을 확인할 수 없습니다.');
    } else if (epochs.length) {
      basis = 'runtime-receipts'; attemptsObserved = epochs.length;
      for (const epoch of epochs) {
        const meta = runtime.find(row => row.sk === `RUNTIME#${epoch}#META`);
        const rows = members.filter(row => row.sk.split('#')[1] === epoch);
        for (let replica = 0; replica < spec.parallelism; replica++) {
          const matching = rows.filter(row => row.replica === replica);
          if (matching.length !== 1) { timingComplete = false; continue; }
          const member = matching[0];
          if (member.processStarted === false) continue;
          if (member.processStarted !== true) { timingComplete = false; continue; }
          const terminal = ['SUCCEEDED', 'FAILED'].includes(String(member.phase));
          const live = !TERMINAL_WF.has(workflow.status) && epoch === ledger.attemptEpoch && ['RUNNING', 'INITIALIZING'].includes(String(member.phase));
          if (!terminal && !live) { timingComplete = false; continue; }
          interval(meta?.releasedAt, terminal ? member.updatedAt : now.toISOString(), 1);
        }
      }
      if (attemptsObserved !== attemptsExpected) timingComplete = false;
    } else if (ledger.attempts === 0 && ['WAITING', 'SKIPPED', 'CANCELLED'].includes(ledger.phase) || !ledger.startedAt && ['LAUNCHING', 'QUEUED', 'PENDING', 'INITIALIZING'].includes(ledger.phase) && ledger.attempts <= 1) {
      basis = 'not-started'; attemptsObserved = ledger.attempts;
    } else {
      basis = 'task-observation'; attemptsObserved = 1;
      interval(ledger.startedAt, TERMINAL_TASK.has(ledger.phase) ? ledger.finishedAt : !TERMINAL_WF.has(workflow.status) ? now.toISOString() : undefined, ledger.replicas);
      if (ledger.attempts > 1) timingComplete = false;
    }
    if (!timingComplete) add(spec.name, 'incomplete_timing', '이전 retry 또는 일부 replica의 시작·종료 기록이 없어 전체 사용 시간을 확정할 수 없습니다.');
    const cpuKnown = requestedCpu !== undefined && Number.isFinite(requestedCpu) && requestedCpu > 0, gpuKnown = validGpu(requestedGpu);
    if (!cpuKnown || !gpuKnown) add(spec.name, 'unknown_resources', '요청 CPU/GPU 수를 해석하지 못했습니다.');
    const knownCpuHours = round(hours * (cpuKnown ? requestedCpu! : 0)), knownGpuHours = round(hours * (gpuKnown ? requestedGpu : 0));
    const priced = fresh && !!rate && rate.gpu !== null && cpuKnown && gpuKnown && requestedCpu! <= rate.vCpu && requestedGpu <= rate.gpu;
    if (hours > 0 && !priced) add(spec.name, 'unpriced_platform', '동일 리전·HyperPod On-Demand 플랫폼의 유효한 단가와 자원 구성을 확인하지 못했습니다.');
    const share = priced ? Math.max(requestedCpu! / rate!.vCpu, requestedGpu === 0 ? 0 : requestedGpu / rate!.gpu!) : 0;
    const knownEstimatedUsd = round(hours * share * (rate?.usdPerHour ?? 0));
    const noCompute = timingComplete && hours === 0;
    return {
      name: spec.name, platform, attemptsObserved, attemptsExpected, replicaHours: round(hours), timingBasis: basis,
      cpuHours: timingComplete && cpuKnown ? knownCpuHours : null, gpuHours: timingComplete && gpuKnown ? knownGpuHours : null,
      estimatedUsd: noCompute ? 0 : timingComplete && priced ? knownEstimatedUsd : null,
      dedicatedInstanceUsd: noCompute ? 0 : timingComplete && priced ? round(hours * rate!.usdPerHour) : null,
      knownCpuHours, knownGpuHours, knownEstimatedUsd, ...(rate ? { rate } : {}),
    };
  });
  const total = (key: 'cpuHours' | 'gpuHours' | 'estimatedUsd' | 'dedicatedInstanceUsd') => results.some(r => r[key] === null) ? null : round(results.reduce((sum, r) => sum + r[key]!, 0));
  return {
    workflowId: workflow.id, name: workflow.name, projectId: workflow.projectId, backendId: workflow.backendId ?? 'default', observedAt: now.toISOString(),
    complete: results.every(r => r.cpuHours !== null && r.gpuHours !== null && r.estimatedUsd !== null),
    cpuHours: total('cpuHours'), gpuHours: total('gpuHours'), estimatedUsd: total('estimatedUsd'), dedicatedInstanceUsd: total('dedicatedInstanceUsd'),
    knownCpuHours: round(results.reduce((sum, r) => sum + r.knownCpuHours, 0)), knownGpuHours: round(results.reduce((sum, r) => sum + r.knownGpuHours, 0)),
    knownEstimatedUsd: round(results.reduce((sum, r) => sum + r.knownEstimatedUsd, 0)), tasks: results, issues,
    pricing: { ...rates, rates: undefined, fresh },
    basis: 'requested-resource-share' as const,
    formula: 'replica 실행시간 × HyperPod 노드 시간단가 × max(요청 CPU/노드 vCPU, 요청 GPU/노드 GPU)',
    exclusions: ['AWS 청구액·할인·세금이 아닙니다.', '유휴/예약 노드, 큐 대기, 이미지 준비·종료, 메모리 비례 배분, 스토리지·네트워크·서비스 비용은 제외합니다.',
      'runtime 기록은 barrier–terminal 시간을 사용합니다. 보조 상태 관측은 startedAt–finishedAt 기준으로 준비/종료 시간이 포함될 수 있습니다. 실제 CPU/GPU 이용률이 아닙니다.', '전용 노드 가정 금액은 replica마다 한 노드를 사용하는 경우입니다. 같은 노드를 공유하면 중복됩니다.',
      '과거 실행도 표시된 조회 시점의 단가로 재산정합니다. 누락된 retry 시간은 0으로 간주하지 않습니다.'],
  };
}
export async function runUsage(id: string, session: Session, repo: Repo = getRepo(), rates?: RateSnapshot, now = () => new Date()) {
  const workflow = await repo.getWorkflow(id);
  if (!workflow || !await canReadResource(session, workflow, repo)) throw notFound('workflow');
  const [tasks, runtime, snapshot] = await Promise.all([repo.listTasks(id), repo.kv.query(`WF#${id}`, 'RUNTIME#'), rates ?? readRates(repo)]);
  return estimateRunUsage(workflow, tasks, runtime, snapshot, now(), config().region);
}
export async function projectUsage(id: string, session: Session, repo: Repo = getRepo(), now = () => new Date()) {
  const project = await resolveProject(session, id, repo);
  const rates = await readRates(repo), observed = now();
  const runs: Awaited<ReturnType<typeof runUsage>>[] = [];
  const seen = new Set<string>(); let cursor: string | undefined, completeDiscovery = true;
  do {
    const page = await repo.listWorkflowsPage({ projectId: id, limit: 100, cursor });
    for (const item of page.items) if (!seen.has(item.id)) {
      seen.add(item.id); runs.push(await runUsage(item.id, session, repo, rates, () => observed));
    }
    if (page.cursor && (page.cursor === cursor || runs.length >= 1000)) { completeDiscovery = false; break; }
    cursor = page.cursor;
  } while (cursor);
  const sum = (key: 'cpuHours' | 'gpuHours' | 'estimatedUsd') => !completeDiscovery || runs.some(r => r[key] === null) ? null : round(runs.reduce((total, r) => total + r[key]!, 0));
  return { project: { id: project.id, name: project.name, backendId: project.backendId ?? 'default' }, observedAt: observed.toISOString(),
    cpuHours: sum('cpuHours'), gpuHours: sum('gpuHours'), estimatedUsd: sum('estimatedUsd'), runs,
    complete: completeDiscovery && runs.every(r => r.complete), completeDiscovery,
    discoveryBasis: '프로젝트 인덱스에서 조회한 실행 기준입니다. 방금 생성된 실행은 아직 포함되지 않을 수 있습니다.',
    pricing: { ...rates, rates: undefined, fresh: rateIsFresh(rates, observed) } };
}
