# Dashboard A — Cost Explorer 캐시와 SFN/SQS 문서 정리 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cost Explorer 호출을 1시간 캐시로 줄이고, 기능 문서·다이어그램에서 이미 제거된 Step Functions/SQS/EventBridge/callbacks 테이블 설명을 지운다.

**Architecture:** `server/aws/cost.ts`에 모듈 스코프 캐시 함수를 추가하고 개요·관리자 두 소비자가 이를 공유한다. 문서는 `dashboard/docs/dashboard-features-and-aws-architecture.md`와 `docs/diagrams/gen_diagrams.py`만 고치고 PNG를 재생성한다.

**Tech Stack:** Next.js 16 route handlers, vitest, Python 3 draw.io 생성기 + `drawio` CLI.

**Spec:** `docs/designs/2026-09-19-dashboard-modular-http-logs-design.md` §4

## Global Constraints

- 모든 명령은 `dashboard/web` 또는 `dashboard/docs/diagrams`에서 실행한다. 테스트는 `npm test -- <file>`(vitest), 타입은 `npm run typecheck`.
- UI 문자열은 `web/src/lib/i18n/messages/*`에만 두며 컴포넌트에 한글 리터럴을 쓰지 않는다(`no-hardcoded-strings.test.ts`).
- 커밋 메시지는 `feat|fix|docs(dashboard): …` 형식, 끝에 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- 과거 설계·계획 문서(`docs/designs/2026-09-16…`, `docs/plans/2026-09-1[68]…`)는 이력이므로 수정하지 않는다.

---

### Task 1: `cachedAccountCost()` — 1시간 인프로세스 캐시

**Files:**
- Modify: `dashboard/web/src/server/aws/cost.ts`
- Modify: `dashboard/web/src/server/services/overview.ts:2,11,32-35,63`
- Modify: `dashboard/web/src/app/api/cost/route.ts`
- Modify: `dashboard/web/src/components/pages/AdminPage.tsx:566`
- Test: `dashboard/web/src/server/aws/cost.test.ts`

**Interfaces:**
- Produces: `cachedAccountCost(now?: () => number): Promise<AccountCost & { stale?: boolean }>`; `resetAccountCostCache(): void` (테스트 전용).

- [ ] **Step 1: 실패하는 테스트 추가**

`cost.test.ts` 끝에 추가:

```ts
import { cachedAccountCost, resetAccountCostCache } from './cost';

describe('cachedAccountCost', () => {
  beforeEach(() => resetAccountCostCache());
  const page = { ResultsByTime: [{ TimePeriod: { Start: '2026-09-15' }, Groups: [{ Keys: ['EC2'], Metrics: { UnblendedCost: { Amount: '1', Unit: 'USD' } } }] }] };
  it('calls Cost Explorer once within the hour and again after it', async () => {
    let now = 1_000_000;
    send.mockResolvedValue(page);
    await cachedAccountCost(() => now);
    await cachedAccountCost(() => now + 3_599_000);
    expect(send).toHaveBeenCalledTimes(1);
    await cachedAccountCost(() => now + 3_600_001);
    expect(send).toHaveBeenCalledTimes(2);
  });
  it('returns the previous value marked stale when a refresh fails', async () => {
    send.mockResolvedValueOnce(page);
    const first = await cachedAccountCost(() => 0);
    send.mockRejectedValueOnce(new Error('throttled'));
    const second = await cachedAccountCost(() => 3_600_001);
    expect(second.total).toBe(first.total);
    expect(second.stale).toBe(true);
  });
  it('rethrows when there is no cached value to fall back to', async () => {
    send.mockRejectedValueOnce(new Error('throttled'));
    await expect(cachedAccountCost(() => 0)).rejects.toThrow('throttled');
  });
});
```

파일 상단 import를 `import { beforeEach, describe, expect, it, vi } from 'vitest';`로 바꾼다.

- [ ] **Step 2: 실패 확인**

Run: `cd dashboard/web && npm test -- src/server/aws/cost.test.ts`
Expected: FAIL — `cachedAccountCost is not a function` 또는 export 없음.

- [ ] **Step 3: 구현**

`cost.ts` 끝에 추가:

```ts
const COST_TTL_MS = 3_600_000;
let accountCostCache: { at: number; value: AccountCost } | undefined;
/** Cost Explorer bills per request; every reader shares one hourly snapshot. */
export async function cachedAccountCost(now: () => number = Date.now): Promise<AccountCost & { stale?: boolean }> {
  if (accountCostCache && now() - accountCostCache.at <= COST_TTL_MS) return accountCostCache.value;
  try {
    const value = await last30DaysByService();
    accountCostCache = { at: now(), value };
    return value;
  } catch (error) {
    if (accountCostCache) return { ...accountCostCache.value, stale: true };
    throw error;
  }
}
export function resetAccountCostCache(): void { accountCostCache = undefined; }
```

`AccountCost`에 `stale?: boolean;` 필드를 추가한다.

- [ ] **Step 4: 소비자 교체**

`overview.ts`:
- 2행 import를 `import { cachedAccountCost } from '../aws/cost';`로.
- 11행 `let costCache …` 삭제.
- 32~35행을 다음으로 교체:
```ts
  const cost = session?.role === 'admin' ? (await safe(cachedAccountCost(), undefined)).value : undefined;
```
- 63행 `cost: session?.role === 'admin' ? costCache?.value : undefined,` → `cost,`.

`app/api/cost/route.ts`:
```ts
import { NextResponse } from 'next/server';
import { route } from '@/server/api';
import { cachedAccountCost } from '@/server/aws/cost';
export const dynamic = 'force-dynamic';
export const GET = route('admin', async () =>
  NextResponse.json(await cachedAccountCost(), { headers: { 'cache-control': 'private, max-age=600' } }));
```

`AdminPage.tsx:566`: `{ refetch: 60000 }` → `{ refetch: 600000 }`.

- [ ] **Step 5: 테스트·타입 통과 확인**

Run: `cd dashboard/web && npm test -- src/server/aws/cost.test.ts src/server/services && npm run typecheck`
Expected: PASS, 타입 오류 없음. `overview.test.ts`가 있으면 `costCache` 관련 mock이 깨질 수 있으니 `../aws/cost` mock을 `cachedAccountCost`로 바꾼다.

- [ ] **Step 6: 커밋**

```bash
git add dashboard/web/src/server/aws/cost.ts dashboard/web/src/server/aws/cost.test.ts dashboard/web/src/server/services/overview.ts dashboard/web/src/app/api/cost/route.ts dashboard/web/src/components/pages/AdminPage.tsx
git commit -m "perf(dashboard): cache Cost Explorer for one hour and poll the admin cost card every 10 minutes

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: 기능 문서에서 Step Functions/SQS 설명 제거

**Files:**
- Modify: `dashboard/docs/dashboard-features-and-aws-architecture.md` 6, 53, 55, 169-170, 445, 510-511, 522, 531-532행

- [ ] **Step 1: 각 행을 다음 내용으로 교체**

6행 안내문:
```
> 이 문서는 **현재 코드와 배포 상태**를 기술합니다. 2026-09-18 [아키텍처 단순화 설계](../../docs/designs/2026-09-18-dashboard-architecture-simplification.md)에 따라 Step Functions·SQS·callbacks 테이블은 제거되었고 WAF·알람·아티팩트 수명 주기가 적용되었습니다.
```

53행 원장 행: `+ \`callbacks\` 테이블` 삭제 →
```
| 원장 | DynamoDB 단일 테이블 `physical-ai-dashboard-913524902871-us-east-1`(pk/sk, GSI `gsi1`, TTL) | 프로젝트·워크플로·태스크·데이터셋 버전·세션·감사·임대·outbox 등 모든 상태 |
```

55행 오케스트레이션 행:
```
| 오케스트레이션 | controller(Fargate) 5초 reconcile 루프 + DynamoDB 임대·outbox | 워크플로 수명은 DynamoDB 상태와 Kubernetes Job `activeDeadlineSeconds`가 집행. 외부 큐·상태 머신 없음 |
```

169~170행(§4.4 2~3단계):
```
2. controller(Fargate)가 5초마다 미완료 워크플로를 임대(`WF#<id>/LEASE`) 아래에서 reconcile하며 DAG를 컴파일합니다. 태스크는 `batch/v1 Job` 또는 그룹형 `jobset.x-k8s.io/v1alpha2 JobSet`으로 생성되고 `kueue.x-k8s.io/queue-name=<ns>-localqueue`, priority-class 라벨, FSx PVC subPath(`projects/<p>/…`), 서비스 계정 `pai-workflow`(EKS Pod Identity), non-root, NetworkPolicy(IMDS/Pod Identity egress 차단)를 갖습니다. Pod는 Cloud Map 이름으로 controller의 `/runtime/*`(HMAC capability 토큰)에 heartbeat와 결과를 보고합니다.
3. 완료·알림 같은 후속 작업은 `WF#<id>/OUT#<kind>` outbox 항목으로 기록되고 controller가 전달 성공 시 `deliveredAt`을 남깁니다.
```
이후 번호(4→4, 5→5)는 그대로 둔다. 원래 3단계 문장 중 Job/JobSet 설명은 위 2단계로 흡수한다.

445행:
```
- 웹훅 전달은 DynamoDB outbox와 controller 웹훅 루프(5초)가 처리하며 SQS/EventBridge를 쓰지 않습니다. 관리자 `notifyOn` 알림은 별도로 SNS `Publish`입니다.
```

510~511행: 두 행 삭제.

522행: `WORKFLOW_STATE_MACHINE_ARN`, `WORKFLOW_QUEUE_URL`, `WORKFLOW_CALLBACKS_TABLE` 세 항목과 `terraform output environment_contract` 문구 삭제. 문장 시작을 `- 컨테이너 환경 변수 계약(\`infra/lib/env-contract.ts\`): …`로.

531행 삭제. 532행:
```
- **보안 하드닝 현황**: WAF(AWS 관리 규칙 + 2000 req/IP), ALB access log, CloudWatch 알람 5개, 아티팩트 버킷 Intelligent-Tiering·noncurrent 만료가 적용되어 있습니다. web 태스크 역할에는 `*` 리소스 권한이 일부 남아 있고 서비스 SG 3001 포트가 VPC CIDR 전체에 열려 있습니다(runtime API는 HMAC capability 토큰으로 보호).
```

- [ ] **Step 2: 잔재 확인**

Run: `grep -n -i "step functions\|sqs\|eventbridge\|callbacks\|state_machine\|WORKFLOW_QUEUE" dashboard/docs/dashboard-features-and-aws-architecture.md`
Expected: 출력 없음.

- [ ] **Step 3: 커밋**

```bash
git add dashboard/docs/dashboard-features-and-aws-architecture.md
git commit -m "docs(dashboard): describe DynamoDB-only orchestration; drop Step Functions/SQS from the feature doc

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: 다이어그램 생성기 정리와 PNG 재생성

**Files:**
- Modify: `dashboard/docs/diagrams/gen_diagrams.py` 29, 331, 335-337, 363-366, 373, 428, 434-436, 459-462행
- Modify: `dashboard/docs/diagrams/README.md:38`
- Regenerate: `dashboard/docs/diagrams/00-전체-아키텍처.drawio.png`, `02-실행-워크플로.drawio.png`, `physical-ai-dashboard-features.drawio`

- [ ] **Step 1: 00 페이지 수정**

- 331행 라벨을 `"DynamoDB (단일 테이블)\nphysical-ai-dashboard-…\n임대 · outbox · 원장"`으로.
- 335~337행(`sfn`, `sqs`, `evb` 노드) 삭제.
- 363~366행(`web→sfn`, `sfn→sqs`, `evb→sqs`, `sqs→ctrl` 엣지 4개) 삭제. 대신 controller가 원장을 폴링하는 엣지를 추가:
```python
    p.e("ctrl", "ddb", "5초 reconcile · 임대 · outbox", exit=(0.75, 0), entry=(0, 0.5), color="#8C4FFF", points=[(1068, 300), (2100, 300), (2100, 209)])
```
  기존 367행 `p.e("ctrl", "ddb", "원장 · 임대 · 로그 아카이브", …)`는 위 줄로 교체(한 개만 남긴다).
- 373행 note 문장에서 `"2026-09-18 승인 설계는 SFN·SQS·callbacks 테이블 제거를 계획하지만 현재 배포에는 존재합니다."` 삭제.
- `cw` 노드(338행)의 x좌표를 `2180`에서 `1900`... 가 아니라 그대로 둔다. 빈 열이 생기지만 좌표 재배치는 이 작업 범위가 아니다.

- [ ] **Step 2: 02 페이지 수정**

- 428행 부제: `"레시피 제출 → 이미지 사전검사 → DynamoDB 원장 → controller(5초 reconcile) → Kueue Job/JobSet on HyperPod EKS → FSx → S3 게시 → Artifacts 탭"`.
- 434~436행(`sfn`, `sqs`, `evb`) 삭제.
- 459~462행 엣지 4개 삭제. `p.e("web", "ddb", "WF# 생성 · outbox", …)`는 유지. 추가:
```python
    p.e("ddb", "ctrl", "5초 reconcile (임대)", exit=(1, 0.5), entry=(0, 0.25), color="#8C4FFF")
```

- [ ] **Step 3: 29행 팔레트의 `"step_functions"`, `"sqs"`, `"eventbridge"` 항목은 다른 페이지에서 쓰지 않으면 삭제**

Run: `grep -n '"step_functions"\|"sqs"\|"eventbridge"' dashboard/docs/diagrams/gen_diagrams.py`
Expected: 29행만 남으면 세 키를 삭제한다. 아이콘 매핑 dict에도 같은 키가 있으면 함께 삭제.

- [ ] **Step 4: README 38행 삭제, 번호 재정렬 불필요(목록 마지막 항목)**

- [ ] **Step 5: 재생성**

Run: `cd dashboard/docs/diagrams && python3 gen_diagrams.py && grep -c "Step Functions\|SQS" physical-ai-dashboard-features.drawio; bash export.sh`
Expected: grep 카운트 0, `export.sh`가 9개 PNG를 다시 쓴다. `drawio` CLI가 없으면 `DRAWIO_CLI` 경로를 지정하거나 이 단계에서 PNG 생성을 건너뛰고 커밋 메시지에 "PNG 재생성 필요"를 적는다.

- [ ] **Step 6: 커밋**

```bash
git add dashboard/docs/diagrams
git commit -m "docs(dashboard): remove Step Functions/SQS/EventBridge from architecture diagrams

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```
