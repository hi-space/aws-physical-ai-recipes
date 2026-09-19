# Dashboard K — 추정 비용 제거 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 대시보드에서 추정 USD 금액, 단가 조회/갱신, 가격표 모듈을 완전히 제거하고, CPU/GPU 시간 사실과 Cost Explorer 실제 비용만 유지한다.

**Architecture:** 현재 `usage.ts`의 `estimateRunUsage()`·`projectUsage()`는 Price List를 요청해 `estimatedUsd`를 계산한다. 이를 제거하고, 요청 자원 기반 CPU/GPU 시간 추정치와 미해결 리소스 문제만 추적한다. `hyperpod-rates` 모듈, `/api/usage/rates` 경로, `PricingBasis` 컴포넌트, IAM Permission, Terraform 설정을 삭제한다.

**Tech Stack:** Next.js 16 route handlers, vitest, Python 3 i18n mirror test.

**Spec:** `docs/designs/2026-09-19-dashboard-composer-views-ux-design.md` §3.7

## Global Constraints

- 모든 명령은 `dashboard/web` 또는 `dashboard/docs`에서 실행한다. 테스트는 `npm test -- <file>`(vitest), 타입은 `npm run typecheck`.
- UI 문자열은 `web/src/lib/i18n/messages/*`에만 두며 컴포넌트에 한글 리터럴을 쓰지 않는다.
- 커밋 메시지는 `refactor|feat(dashboard): …` 형식, 끝에 `Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>`.
- 과거 설계·계획 문서는 수정하지 않는다.
- `RunUsagePanel` 마운트(`WorkflowDetailPage:255-257`)는 props 변경 시 최소한으로 조정만 한다.

---

### Task 1: `usage.ts` DTO에서 가격 정보 제거 및 테스트

**Files:**
- Modify: `dashboard/web/src/server/services/usage.ts:1-151`
- Modify: `dashboard/web/src/server/services/usage.test.ts`
- Delete: `dashboard/web/src/server/aws/hyperpod-rates.ts`
- Delete: `dashboard/web/src/server/aws/hyperpod-rates.test.ts`
- Delete: `dashboard/web/src/server/aws/hyperpod-rates.fixture.ts`

**Interfaces:**
- `TaskUsage`: 제거할 필드 `estimatedUsd`, `dedicatedInstanceUsd`, `rate: ComputeRate`; 유지할 필드 `cpuHours`, `gpuHours`, `knownCpuHours`, `knownGpuHours`, `timingBasis`.
- `RunUsage` (DTO): 제거할 필드 `estimatedUsd`, `dedicatedInstanceUsd`, `pricing` 하위 `rates` 배열; 유지할 필드 `cpuHours`, `gpuHours`, `known*`.
- Issue codes: 제거 `no_rates`, `stale_rates`, `unpriced_platform`; 유지 `missing_ledger`, `incomplete_timing`, `unknown_resources`.

- [ ] **Step 1: 실패하는 테스트 작성**

`usage.test.ts`에서 새 시나리오를 추가 (기존 테스트는 유지):

```ts
it('removes estimated costs when rates are unavailable', async () => {
  const repo = createTestRepo();
  const prices = createTestSnapshot('us-east-1', new Date(finishedAt));
  const workflow = { ...baseWorkflow, spec: parseWorkflowYaml(spec).spec };
  const task = { ...baseTask, finishedAt };
  const runtime = [];
  // No longer passing rates snapshot - should handle undefined rates gracefully
  const result = estimateRunUsage(workflow, [task], runtime, undefined, new Date(finishedAt), 'us-east-1');
  expect(result.estimatedUsd).toBeUndefined();
  expect(result.cpuHours).toBeDefined();
  expect(result.gpuHours).toBeDefined();
  expect(result.issues).toContainEqual({ code: 'missing_ledger' }); // no no_rates issue code
});
it('does not return rate details in task usage', async () => {
  const repo = createTestRepo();
  const prices = createTestSnapshot('us-east-1', new Date(finishedAt));
  // ... setup workflow/task
  const result = estimateRunUsage(workflow, [task], runtime, prices, new Date(finishedAt), 'us-east-1');
  expect(result.tasks[0].rate).toBeUndefined();
  expect(result.tasks[0].cpuHours).toBeDefined();
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd dashboard/web && npm test -- src/server/services/usage.test.ts`
Expected: FAIL — `estimatedUsd` 필드 참조, `rate` 필드, `no_rates` issue 코드 관련 오류.

- [ ] **Step 3: `usage.ts` 수정**

`dashboard/web/src/server/services/usage.ts` 수정:
- 1행 import 제거: `import { rateIsFresh, readRates, ensureRates, type ComputeRate, type RateSnapshot }`
- 14~16행 `TaskUsage` 타입에서 필드 제거:
  ```ts
  // Before:
  // estimatedUsd: number | null; dedicatedInstanceUsd: number | null;
  // knownCpuHours: number; knownGpuHours: number; knownEstimatedUsd: number;
  // rate?: ComputeRate;
  
  // After: (각 필드를 지우고 다음만 남김)
  cpuHours: number | null; gpuHours: number | null;
  knownCpuHours: number; knownGpuHours: number;
  ```

- 26행 `estimateRunUsage` 함수 시그니처: `rates: RateSnapshot | undefined` 제거
  ```ts
  // Before:
  // export function estimateRunUsage(workflow: Workflow, tasks: Task[], runtime: Item[], rates: RateSnapshot | undefined, now: Date, region: string)
  
  // After:
  export function estimateRunUsage(workflow: Workflow, tasks: Task[], runtime: Item[], now: Date, region: string)
  ```

- 28~47행 (rates가 없을 때 early return) 삭제:
  ```ts
  // DELETE these lines:
  if (!rates) {
    issues.push({ code: 'no_rates' });
    // ... early return with null costs
  }
  ```

- 49행 stale_rates 확인 삭제:
  ```ts
  // DELETE:
  // const fresh = rateIsFresh(rates, now);
  // if (!fresh) issues.push({ code: 'stale_rates' });
  ```

- 51행 tasks 매핑에서 모든 가격 관련 로직 제거:
  ```ts
  // BEFORE (line 51-109):
  const results: TaskUsage[] = workflow.spec.workflow.tasks.map(spec => {
    const ledger = tasks.find(t => t.name === spec.name);
    const resource = workflow.spec.workflow.resources[spec.resource];
    const requestedCpu = cpu(resource?.cpu), requestedGpu = resource?.gpu ?? 0;
    const platform = spec.platform ?? resource?.platform;
    const rate = rates.rates.find(r => r.instanceType === platform && r.region === region); // DELETE: rate finding
    let hours = 0, timingComplete = true, attemptsObserved = 0, basis: TaskUsage['timingBasis'] = 'unknown';
    // ... timing calculation (KEEP)
    if (!timingComplete) add(spec.name, 'incomplete_timing');
    const cpuKnown = requestedCpu !== undefined && Number.isFinite(requestedCpu) && requestedCpu > 0, gpuKnown = validGpu(requestedGpu);
    if (!cpuKnown || !gpuKnown) add(spec.name, 'unknown_resources');
    const knownCpuHours = round(hours * (cpuKnown ? requestedCpu! : 0)), knownGpuHours = round(hours * (gpuKnown ? requestedGpu : 0));
    
    // DELETE: unpriced_platform check (line 98-99)
    // DELETE: const priced = ...
    // DELETE: const share = ...
    // DELETE: const knownEstimatedUsd = ...
    
    const noCompute = timingComplete && hours === 0;
    return {
      name: spec.name, platform, attemptsObserved, attemptsExpected, replicaHours: round(hours), timingBasis: basis,
      cpuHours: timingComplete && cpuKnown ? knownCpuHours : null,
      gpuHours: timingComplete && gpuKnown ? knownGpuHours : null,
      // DELETE: estimatedUsd, dedicatedInstanceUsd, knownEstimatedUsd
      knownCpuHours, knownGpuHours,
      // DELETE: ...(rate ? { rate } : {})
    };
  });
  ```

- 111행 `total()` 함수 제거 (estimatedUsd, dedicatedInstanceUsd 계산):
  ```ts
  // BEFORE:
  // const total = (key: 'cpuHours' | 'gpuHours' | 'estimatedUsd' | 'dedicatedInstanceUsd') => ...
  
  // AFTER:
  const total = (key: 'cpuHours' | 'gpuHours') => results.some(r => r[key] === null) ? null : round(results.reduce((sum, r) => sum + r[key]!, 0));
  ```

- 112~124행 return 객체 수정:
  ```ts
  // BEFORE:
  // complete: results.every(r => r.cpuHours !== null && r.gpuHours !== null && r.estimatedUsd !== null),
  // cpuHours: total('cpuHours'), gpuHours: total('gpuHours'), estimatedUsd: total('estimatedUsd'), dedicatedInstanceUsd: total('dedicatedInstanceUsd'),
  // knownCpuHours: ..., knownGpuHours: ..., knownEstimatedUsd: ...
  // pricing: { ...rates, rates: undefined, fresh },
  
  // AFTER:
  complete: results.every(r => r.cpuHours !== null && r.gpuHours !== null),
  cpuHours: total('cpuHours'), gpuHours: total('gpuHours'),
  knownCpuHours: round(results.reduce((sum, r) => sum + r.knownCpuHours, 0)),
  knownGpuHours: round(results.reduce((sum, r) => sum + r.knownGpuHours, 0)),
  tasks: results, issues,
  // DELETE: pricing field
  // DELETE: basis, formula, exclusions (cost explanation fields)
  ```

- 126행 `runUsage()` 수정: ensureRates 호출 제거
  ```ts
  // BEFORE:
  // export async function runUsage(id: string, session: Session, repo: Repo = getRepo(), rates?: RateSnapshot | undefined, now = () => new Date()) {
  //   ...
  //   const [tasks, runtime, snapshot] = await Promise.all([repo.listTasks(id), repo.kv.query(`WF#${id}`, 'RUNTIME#'), rates !== undefined ? Promise.resolve(rates) : ensureRates(config().region, repo)]);
  //   return estimateRunUsage(workflow, tasks, runtime, snapshot, now(), config().region);
  
  // AFTER:
  export async function runUsage(id: string, session: Session, repo: Repo = getRepo(), now = () => new Date()) {
    const workflow = await repo.getWorkflow(id);
    if (!workflow || !await canReadResource(session, workflow, repo)) throw notFound('workflow');
    const [tasks, runtime] = await Promise.all([repo.listTasks(id), repo.kv.query(`WF#${id}`, 'RUNTIME#')]);
    return estimateRunUsage(workflow, tasks, runtime, now(), config().region);
  }
  ```

- 132행 `projectUsage()` 수정: ensureRates 제거, pricing 필드 제거
  ```ts
  // BEFORE:
  // export async function projectUsage(id: string, session: Session, repo: Repo = getRepo(), now = () => new Date()) {
  //   const project = await resolveProject(session, id, repo);
  //   const rates = await ensureRates(config().region, repo), observed = now();
  //   ...
  //   const sum = (key: 'cpuHours' | 'gpuHours' | 'estimatedUsd') => ...
  //   return { project, observedAt, cpuHours, gpuHours, estimatedUsd, runs, complete, completeDiscovery, discoveryBasis, pricing: ... };
  
  // AFTER:
  export async function projectUsage(id: string, session: Session, repo: Repo = getRepo(), now = () => new Date()) {
    const project = await resolveProject(session, id, repo);
    const observed = now();
    const runs: Awaited<ReturnType<typeof runUsage>>[] = [];
    const seen = new Set<string>(); let cursor: string | undefined, completeDiscovery = true;
    do {
      const page = await repo.listWorkflowsPage({ projectId: id, limit: 100, cursor });
      for (const item of page.items) if (!seen.has(item.id)) {
        seen.add(item.id); runs.push(await runUsage(item.id, session, repo, () => observed));
      }
      if (page.cursor && (page.cursor === cursor || runs.length >= 1000)) { completeDiscovery = false; break; }
      cursor = page.cursor;
    } while (cursor);
    const sum = (key: 'cpuHours' | 'gpuHours') => !completeDiscovery || runs.some(r => r[key] === null) ? null : round(runs.reduce((total, r) => total + r[key]!, 0));
    return {
      project: { id: project.id, name: project.name, backendId: project.backendId ?? 'default' },
      observedAt: observed.toISOString(),
      cpuHours: sum('cpuHours'), gpuHours: sum('gpuHours'),
      runs, complete: completeDiscovery && runs.every(r => r.complete), completeDiscovery,
      discoveryBasis: '프로젝트 인덱스에서 조회한 실행 기준입니다. 방금 생성된 실행은 아직 포함되지 않을 수 있습니다.'
    };
  }
  ```

- [ ] **Step 4: 테스트 업데이트 및 통과 확인**

`usage.test.ts` 기존 테스트 수정:
- `ensureRates()` 호출 제거
- `rates` 파라미터 제거 (estimateRunUsage 호출에서)
- 모든 `estimatedUsd` 어서션 제거
- 모든 `pricing` 필드 검증 제거

Run: `cd dashboard/web && npm test -- src/server/services/usage.test.ts src/server/services/usage && npm run typecheck`
Expected: PASS, 타입 오류 없음.

- [ ] **Step 5: `hyperpod-rates.ts` 파일 삭제**

```bash
rm -f dashboard/web/src/server/aws/hyperpod-rates.ts dashboard/web/src/server/aws/hyperpod-rates.test.ts dashboard/web/src/server/aws/hyperpod-rates.fixture.ts
```

Run: `cd dashboard/web && npm test -- src/server && npm run typecheck`
Expected: PASS, 타입 오류 없음 (hyperpod-rates 참조 없음).

- [ ] **Step 6: 커밋**

```bash
git add dashboard/web/src/server/services/usage.ts dashboard/web/src/server/services/usage.test.ts
git add -u dashboard/web/src/server/aws/hyperpod-rates.ts dashboard/web/src/server/aws/hyperpod-rates.test.ts dashboard/web/src/server/aws/hyperpod-rates.fixture.ts
git commit -m "refactor(dashboard): remove estimated costs from usage DTOs; drop rates module

Removes estimatedUsd, dedicatedInstanceUsd, pricing information, and issue codes
(no_rates, stale_rates, unpriced_platform). Keeps CPU/GPU hour estimates and
timing basis. Deletes hyperpod-rates.ts, rate-fetching logic, and rate snapshot
parameters. Cost Explorer actuals remain on admin Overview page.

Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>"
```

---

### Task 2: UI 컴포넌트 및 i18n 업데이트

**Files:**
- Modify: `dashboard/web/src/components/usage/UsageSummary.tsx` (remove PricingBasis, update RunUsageView, remove rate fields)
- Modify: `dashboard/web/src/components/pages/UsagePage.tsx` (remove PricingBasis render, remove admin refresh button)
- Modify: `dashboard/web/src/components/pages/AdminPage.tsx` (remove refresh rates button/mutation at line ~566)
- Modify: `dashboard/web/src/lib/i18n/messages/usage.ts` (remove i18n keys for deleted strings)
- Modify: `dashboard/web/src/components/pages/UsageScaling.browser.test.ts` (remove fixture references, update expectations)

**Interfaces:**
- `RunUsageView` props: unchanged (still receives `RunUsage` but fewer fields)
- Remove exports: `PricingBasis`, `usageUsd` (used only by deleted component), `usageNumber` (check usage)

- [ ] **Step 1: `UsageSummary.tsx` 수정**

`dashboard/web/src/components/usage/UsageSummary.tsx` 개정:

**Line 1-25 (imports/helpers) 유지 - 타입은 업데이트**

**Line 26-35 (PricingBasis component) 삭제:**
```ts
// DELETE this entire function:
export function PricingBasis({ pricing }: { pricing: RunUsage['pricing'] }) { ... }
```

**Line 36-64 (RunUsageView) 수정:**
```ts
// BEFORE:
export function RunUsageView({ usage }: { usage: RunUsage }) {
  ...
  return <div className="space-y-4">
    <div className="grid gap-3 md:grid-cols-3">
      <Stat label={t('cpuEstimate')} value={usageNumber(usage.cpuHours, unknownText, fmtNum)} sub={usage.cpuHours === null ? `${t('partial')} ${usageNumber(usage.knownCpuHours, unknownText, fmtNum)}` : t('cpuEstimateSub')} />
      <Stat label={t('gpuEstimate')} value={usageNumber(usage.gpuHours, unknownText, fmtNum)} sub={usage.gpuHours === null ? `${t('partial')} ${usageNumber(usage.knownGpuHours, unknownText, fmtNum)}` : t('gpuEstimateSub')} />
      <Stat label={t('estimateCost')} value={usageUsd(usage.estimatedUsd, unknownText, fmtUsd)} sub={usage.estimatedUsd === null ? `${t('priceConfirmed')} ${usageUsd(usage.knownEstimatedUsd, unknownText, fmtUsd)}` : t('estimateCostSub')} />
    </div>
    ...
    <Table head={[tc('task'), t('attempts'), 'CPU-hours', 'GPU-hours', t('estimateCost'), `Platform / ${t('nodeRate')}`]} dense>
      {usage.tasks.map(task => <tr key={task.name}>
        <td>{task.name}</td><td>{task.attemptsObserved} / {task.attemptsExpected}<br />{translateTimingBasis(task.timingBasis, t)}</td>
        <td>{usageNumber(task.cpuHours, unknownText, fmtNum)}</td><td>{usageNumber(task.gpuHours, unknownText, fmtNum)}</td><td>{usageUsd(task.estimatedUsd, unknownText, fmtUsd)}</td>
        <td>{task.platform ?? t('platformNotSpecified')}<br />{task.rate ? t('ratePer', { usd: usageUsd(task.rate.usdPerHour, unknownText, fmtUsd), sku: task.rate.sku }) : t('noConfirmedRate')}</td>
      </tr>)}
    </Table>
    ...
    <details>...
      <p className="text-sm">{t('dedicatedNodeAssumption', { usd: usageUsd(usage.dedicatedInstanceUsd, unknownText, fmtUsd) })}</p>
      <PricingBasis pricing={usage.pricing} />
      ...
    </details>

// AFTER:
export function RunUsageView({ usage }: { usage: RunUsage }) {
  const t = useT('usage');
  const tc = useT('common');
  const { fmtNum } = useFormat(); // REMOVE: fmtUsd
  const unknownText = t('unknown');
  return <div className="space-y-4">
    <div className="grid gap-3 md:grid-cols-2">
      <Stat label={t('cpuEstimate')} value={usageNumber(usage.cpuHours, unknownText, fmtNum)} sub={usage.cpuHours === null ? `${t('partial')} ${usageNumber(usage.knownCpuHours, unknownText, fmtNum)}` : t('cpuEstimateSub')} />
      <Stat label={t('gpuEstimate')} value={usageNumber(usage.gpuHours, unknownText, fmtNum)} sub={usage.gpuHours === null ? `${t('partial')} ${usageNumber(usage.knownGpuHours, unknownText, fmtNum)}` : t('gpuEstimateSub')} />
    </div>
    <Badge tone={usage.complete ? 'info' : 'warn'}>{usage.complete ? t('recordBasis') : t('partialRecord')}</Badge>
    <Table head={[tc('task'), t('attempts'), 'CPU-hours', 'GPU-hours', 'Platform']} dense>
      {usage.tasks.map(task => <tr key={task.name}>
        <td>{task.name}</td><td>{task.attemptsObserved} / {task.attemptsExpected}<br />{translateTimingBasis(task.timingBasis, t)}</td>
        <td>{usageNumber(task.cpuHours, unknownText, fmtNum)}</td><td>{usageNumber(task.gpuHours, unknownText, fmtNum)}</td>
        <td>{task.platform ?? t('platformNotSpecified')}</td>
      </tr>)}
    </Table>
    {!!usage.issues.length && <ul aria-label={t('usageEstimationLimits')} className="space-y-1 text-sm text-fg-muted">{usage.issues.map((issue, index) => <li key={`${issue.task}:${issue.code}:${index}`}>{issue.task ? `${issue.task}: ` : ''}{t(`issue_${issue.code}` as any)}</li>)}</ul>}
  </div>;
}
```

**Line 66-74 (RunUsagePanel) 유지 - 내용은 그대로**

- [ ] **Step 2: `UsagePage.tsx` 수정**

Import 줄 수정:
```ts
// BEFORE:
import { PricingBasis, usageNumber, usageUsd } from '@/components/usage/UsageSummary';

// AFTER:
import { usageNumber } from '@/components/usage/UsageSummary';
```

PricingBasis 렌더 제거 (line ~72):
```ts
// DELETE:
// <div className="mt-4"><PricingBasis pricing={query.data.pricing} /></div>
```

Admin 새로고침 버튼 제거 (line ~27-29로 추정):
```ts
// Search for:
// getByRole('button', { name: '공식 단가 새로 조회' })
// or
// onClick={() => refreshRates()}
// DELETE any such button element
```

- [ ] **Step 3: `AdminPage.tsx` 수정**

line ~566에서 단가 새로고침 버튼 찾아 제거:

```ts
// DELETE or comment out:
// {session.role === 'admin' && <Button onClick={() => refreshRates()}>공식 단가 새로 조회</Button>}
// or similar
```

또는 grep으로 확인:
```bash
grep -n "refreshRates\|단가 새로\|Refresh.*rates" dashboard/web/src/components/pages/AdminPage.tsx
```

찾은 줄을 삭제.

- [ ] **Step 4: i18n 키 삭제**

`dashboard/web/src/lib/i18n/messages/usage.ts`에서 제거할 i18n 키:
```ts
// DELETE these key-value pairs from both ko and en:
// - refreshRates / refreshUsage 버튼 레이블
// - estimateCost / 추정 비용 통계 레이블
// - stalePrice, retrieved, publicationDate, pastRuns, officialPricing, nodeRate, noConfirmedRate
// - issue_no_rates, issue_stale_rates, issue_unpriced_platform
// - ratePer, dedicatedNodeAssumption, priceConfirmed, estimateCostSub
// - pastRuns, disclamer 등 가격 설명 문구

// List of exact keys to DELETE from both en and ko blocks:
// en: refreshRates, estimateCost, estimateCostSub, priceConfirmed, stalePrice, retrieved, publicationDate, officialPricing, pastRuns, nodeRate, noConfirmedRate, ratePer, dedicatedNodeAssumption, issue_no_rates, issue_stale_rates, issue_unpriced_platform, disclamer
// ko: refreshRates 대응, 추정 비용 등

// Check both objects in the file and remove entries
```

정확한 grep으로 확인:
```bash
cd dashboard/web && npm test -- src/lib/i18n/messages/usage.ts 2>&1 | grep -i "unused\|not found"
```

실제 파일을 읽고 삭제할 키를 파악한 후 모두 제거.

- [ ] **Step 5: `UsageScaling.browser.test.ts` 업데이트**

Line 8 import 수정:
```ts
// BEFORE:
import { createTestSnapshot } from '@/server/aws/hyperpod-rates.fixture';

// AFTER: DELETE this import (not needed anymore)
```

Line 18-19 테스트 데이터 수정:
```ts
// BEFORE:
const testRates = createTestSnapshot('us-east-1', new Date(finishedAt));
const known = estimateRunUsage(workflow, [task], [], testRates, new Date(finishedAt), 'us-east-1');
const unknown = estimateRunUsage({ ...workflow, id: 'unknown', name: 'Missing history' }, [{ ...task, attempts: 2 }], [], testRates, new Date(finishedAt), 'us-east-1');

// AFTER:
const known = estimateRunUsage(workflow, [task], [], new Date(finishedAt), 'us-east-1');
const unknown = estimateRunUsage({ ...workflow, id: 'unknown', name: 'Missing history' }, [{ ...task, attempts: 2 }], [], new Date(finishedAt), 'us-east-1');
```

Line 47 API 응답 수정:
```ts
// BEFORE:
if (url.pathname === '/api/usage/rates') return rateFailure ? json({ error: '공식 단가 조회 실패' }, 503) : json(testRates);

// AFTER: DELETE this entire route handler
```

Line 81-90 테스트 케이스 수정:
```ts
// BEFORE test case:
it('shows project/run estimates, unknown totals, and timestamped official rate basis without claiming account billing', async () => {
  admin = false; await page.goto(origin + '/usage');
  await page.getByRole('link', { name: 'Known run', exact: true }).waitFor();
  expect(await page.getByText(/\$3\.06/, { exact: false }).count()).toBe(1);
  expect(await page.getByText('알 수 없음', { exact: true }).count()).toBeGreaterThan(0);
  expect(await page.getByText(/가격표 게시/).count()).toBe(1);
  expect(await page.getByRole('link', { name: '공식 AWS 가격표 원문' }).getAttribute('href')).toBe(testRates.sourceUrl);
  expect(await page.getByRole('button', { name: '공식 단가 새로 조회' }).count()).toBe(0);
  expect(calls.some(c => c.path === '/api/cost')).toBe(false);
});

// AFTER test case:
it('shows project/run estimates with CPU/GPU hours, no cost figures', async () => {
  admin = false; await page.goto(origin + '/usage');
  await page.getByRole('link', { name: 'Known run', exact: true }).waitFor();
  expect(await page.getByText(/CPU-hours/, { exact: false }).count()).toBeGreaterThan(0);
  expect(await page.getByText(/GPU-hours/, { exact: false }).count()).toBeGreaterThan(0);
  expect(await page.getByText(/\$/, { exact: false }).count()).toBe(0); // No USD amounts
  expect(await page.getByText('알 수 없음', { exact: true }).count()).toBeGreaterThan(0);
  expect(calls.some(c => c.path === '/api/cost')).toBe(false);
});
```

Line 91-100 테스트 케이스 제거:
```ts
// DELETE this test:
it('retains visible source timestamps when an admin price refresh fails', async () => { ... });
```

- [ ] **Step 6: 테스트·타입 통과 확인**

Run: `cd dashboard/web && npm test -- src/components/pages/UsageScaling.browser.test.ts src/components/usage/UsageSummary && npm run typecheck`
Expected: PASS, 타입 오류 없음, 브라우저 테스트도 통과.

- [ ] **Step 7: 커밋**

```bash
git add dashboard/web/src/components/usage/UsageSummary.tsx dashboard/web/src/components/pages/UsagePage.tsx dashboard/web/src/components/pages/AdminPage.tsx dashboard/web/src/lib/i18n/messages/usage.ts dashboard/web/src/components/pages/UsageScaling.browser.test.ts
git commit -m "refactor(dashboard): remove cost estimation UI and admin rate refresh

Removes PricingBasis component, 'estimatedUsd' stat tile, rate table column,
admin refresh button, and related i18n keys for cost, rates, pricing metadata.
Keeps CPU/GPU hour estimates and timing basis. Updates browser test to verify
no USD amounts are rendered.

Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>"
```

---

### Task 3: API 경로 및 스토어 삭제

**Files:**
- Delete: `dashboard/web/src/app/api/usage/rates/route.ts`
- Check: `dashboard/web/src/server/store` for USAGE_PRICING store accessors (grep output showed none exist separately - they are only in hyperpod-rates.ts)

**Interfaces:**
- Remove: `GET /api/usage/rates` route
- No store DTOs to update (rates are not a stored type)

- [ ] **Step 1: `app/api/usage/rates/route.ts` 삭제**

```bash
rm -f dashboard/web/src/app/api/usage/rates/route.ts
```

- [ ] **Step 2: 스토어 참조 확인 및 정리**

Grep으로 USAGE_PRICING 참조 확인:
```bash
grep -rn "USAGE_PRICING\|/api/usage/rates" dashboard/web/src --include="*.ts" --include="*.tsx" | grep -v "node_modules\|.next"
```

Expected: 없어야 함 (task 1에서 삭제됨).

- [ ] **Step 3: 타입 통과 및 빌드 확인**

Run: `cd dashboard/web && npm run typecheck && npm run build`
Expected: PASS, 타입 오류 없음, 빌드 성공.

- [ ] **Step 4: 커밋**

```bash
git add -u dashboard/web/src/app/api/usage/rates/route.ts
git commit -m "refactor(dashboard): delete unused /api/usage/rates endpoint

Removes the rate snapshot retrieval and refresh route; rates are no longer
computed or displayed in the UI.

Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>"
```

---

### Task 4: IAM 권한 및 Terraform 설정 정리

**Files:**
- Check: `dashboard/infra/lib/**/*.ts` for pricing-related IAM statements
- Check: `dashboard/terraform/**/*.tf` for pricing-related resources

**Goal:** Price List에 대한 IAM `pricing:GetProducts` 또는 유사 권한 제거, 가격 조회 관련 권한 정리.

- [ ] **Step 1: IAM 권한 검색**

```bash
grep -rn "GetProducts\|pricing\|Pricing\|pricing:GetAttribute" dashboard/infra/lib --include="*.ts" | head -20
```

Expected: 결과 없거나, Price List 권한이 있으면 목록 확인.

만약 결과가 있으면, 그 파일에서 권한 블록을 찾아 제거. 예상되는 형태:
```ts
// CDK: actions: ['pricing:GetProducts', 'pricing:GetAttributes'] 또는 유사
```

- [ ] **Step 2: Terraform 설정 검색**

```bash
grep -rn "pricing\|GetProducts" dashboard/terraform --include="*.tf" | head -20
```

Expected: 결과 없거나, 정책 또는 역할 정의에서 pricing 작업 제거.

- [ ] **Step 3: 확인 후 커밋 (변경사항이 있으면)**

변경이 있으면:
```bash
git add dashboard/infra/lib dashboard/terraform
git commit -m "refactor(dashboard): remove Price List IAM permissions

Removes AWS Pricing API permissions (pricing:GetProducts, pricing:GetAttributes)
from web task role, as the rate-fetching feature has been deleted.

Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>"
```

변경이 없으면 Skip.

---

### Task 5: 기능 문서 업데이트 (§15)

**Files:**
- Modify: `dashboard/docs/dashboard-features-and-aws-architecture.md` at line 389-396

**Goal:** §15 사용량·비용 섹션 전체 재작성 - 가격 추정, 단가 갱신 버튼, PricingBasis, 단가 관련 설명 제거; CPU/GPU 시간 사실과 Cost Explorer 실제 비용만 기술.

- [ ] **Step 1: 기존 내용 읽기**

Already read at offset 389-396. Summary:
- Line 393: 사용량 새로고침, **단가 새로 고침**, 통계 CPU/GPU/추정 USD, PricingBasis
- Line 394: 단가·타이밍·리소스 정보 없으면 null
- Line 395: 단가 출처, USAGE_PRICING# DynamoDB 저장
- Line 396: 추정 금액 설명, Cost Explorer 실제 비용

- [ ] **Step 2: 새 내용 작성**

Replace line 389-396 with:

```
## 15. 사용량

![사용량](screenshots/15-usage-cost.png)

- 프로젝트 선택, **사용량 새로 고침**. 통계 CPU-hour / GPU-hour, 실행별 표(완료/불완전 배지, 실행 상세 링크).
- `GET /api/usage?projectId`: 워크플로 ≤1000건에 대해 DynamoDB 태스크 원장과 `WF#<id>/RUNTIME#<epoch>#MEMBER` 영수증으로 **replica 시간 × max(요청 CPU/노드 vCPU, 요청 GPU/노드 GPU)** 계산. 타이밍·리소스 정보가 없으면 `null`(사유 `missing_ledger`, `incomplete_timing`, `unknown_resources`)로 남기고 추정하지 않습니다.
- 금액은 **추정하지 않으며** 실제 CPU/GPU 활용률이 아니고 idle 인프라·스토리지·네트워크는 제외합니다. 홈·관리 패널의 "AWS 계정 전체 비용"은 Cost Explorer 값으로 대시보드 외 서비스(EC2, Bedrock 등)를 포함합니다.
```

- [ ] **Step 3: 잔재 확인**

Grep:
```bash
grep -n "단가\|pricing\|rate\|estimatedUsd\|PricingBasis\|USAGE_PRICING" dashboard/docs/dashboard-features-and-aws-architecture.md | grep -v "^389:\|^390:\|^391:\|^392:\|^393:\|^394:\|^395:\|^396:"
```

Expected: 추가 언급 없음 (§15 외부).

만약 라인 170도 확인 (초록 메모에 §15 언급):
```bash
grep -n "\.15\|§15" dashboard/docs/dashboard-features-and-aws-architecture.md
```

Line 170: `§9`, `§15`에 대한 언급 확인. 이 섹션은 유지 (다른 기능 참조).

- [ ] **Step 4: 커밋**

```bash
git add dashboard/docs/dashboard-features-and-aws-architecture.md
git commit -m "docs(dashboard): update §15 usage section; remove cost estimation

Removes references to price list fetching, estimated USD, admin rate refresh,
and pricing basis. Simplifies to CPU/GPU hour estimates and Cost Explorer
actuals.

Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>"
```

---

### Task 6: 전체 `npm test` + `npm run typecheck` + 최종 브라우저 테스트

**Files:**
- No file changes; full test suite validation

- [ ] **Step 1: 전체 테스트 실행**

Run: `cd dashboard/web && npm test`
Expected: PASS 또는 최소한 새 변경과 무관한 기존 실패만 있어야 함.

- [ ] **Step 2: 타입 체크**

Run: `cd dashboard/web && npm run typecheck`
Expected: PASS, 타입 오류 없음.

- [ ] **Step 3: 브라우저 테스트 (선택)**

Run: `cd dashboard/web && npm test -- src/components/pages/UsageScaling.browser.test.ts`
Expected: PASS (Chromium 설치 필요).

---

### Task 7: README 및 메모리 업데이트 (선택)

**Files:**
- Modify: `dashboard/README.md` (if mentions "추정" or "단가")

Grep 확인:
```bash
grep -n "추정\|estimated\|단가\|rate" dashboard/README.md | head -10
```

내용이 없으면 Skip. 있으면 언급 제거.

---

## Self-Review: Spec §3.7 Bullets to Tasks

§3.7 spec bullet → implemented in:

1. ✅ "Drop `estimatedUsd`, `dedicatedInstanceUsd`, `rate`, and `no_rates`/`stale_rates`/`unpriced_platform` issue codes"
   - **Task 1:** usage.ts 필드·이슈코드 제거

2. ✅ "Keep `cpuHours`, `gpuHours`, per-task timing, `known*`, remaining issue codes"
   - **Task 1:** usage.ts 유지할 필드 확인

3. ✅ "Delete `hyperpod-rates.ts` (+ test/fixture), `/api/usage/rates` route"
   - **Task 1 + Task 3:** 모듈 및 경로 삭제

4. ✅ "Delete `USAGE_PRICING#` store accessors"
   - **Task 1:** RateSnapshot 타입 제거 (스토어 접근자 없음)

5. ✅ "Remove admin '단가 갱신' button and PricingBasis from UI"
   - **Task 2:** AdminPage, UsagePage, UsageSummary 컴포넌트 수정

6. ✅ "Delete Price List IAM statement in infra/lib and terraform"
   - **Task 4:** IAM 권한 정리

7. ✅ "Remove i18n keys for deleted strings (ko/en mirror test)"
   - **Task 2:** messages/usage.ts 키 삭제

8. ✅ "Keep Cost Explorer actuals (admin Overview + Admin → Cost)"
   - **Unchanged:** cost.ts, AdminPage cost tab, OverviewPage untouched

---

**End of Plan**

Estimated effort: ~6 hours (tests, full validation, multiple file updates)
Commit count: ~6 commits (one per main task)
Test passing: Every commit leaves tests in PASS state
