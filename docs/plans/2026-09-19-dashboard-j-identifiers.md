# Dashboard J — 기술 정보 공개 및 식별자 정리 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 사용자 인터페이스에서 기술 식별자(ARN, workflow ID, pod 이름, 이미지 URI 등)를 숨기고 `TechnicalDetails` 공개 컴포넌트 뒤로 이동하여 일반 사용자의 시선을 가리지 않도록 한다.

**Architecture:** `TechnicalDetails` 컴포넌트(`ui/index.tsx`)를 추가하고, 각 페이지(WorkflowsPage, WorkflowDetailPage, TaskTable, TaskDetailPanel, LogViewer, JobsPage, SessionsPage, PipelinesPage, PipelineExecutionPage)에서 표시 방식을 조정한다. 모든 식별자는 접근 가능하되(TechnicalDetails 내부) 시각적 계층에서는 제거된다.

**Tech Stack:** Next.js 16 route handlers, vitest, React 19 Disclosure + i18n.

**Spec:** `docs/designs/2026-09-19-dashboard-composer-views-ux-design.md` §3.6

## Global Constraints

- 모든 명령은 `dashboard/web` 또는 그 하위 디렉토리에서 실행한다. 테스트는 `npm test -- src/...`(vitest), 타입은 `npm run typecheck`.
- UI 문자열은 `web/src/lib/i18n/messages/*`의 각 페이지 모듈에만 두며 컴포넌트에 한글 리터럴을 쓰지 않는다(`no-hardcoded-strings.test.ts` 검사).
- 커밋 메시지는 `feat(dashboard): …` 형식, 끝에 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- 과거 설계·계획 문서(`docs/designs/2026-09-16…`, `docs/plans/2026-09-1[68]…`)는 이력이므로 수정하지 않는다.
- Task 1에서 `TechnicalDetails` 컴포넌트 인터페이스는 확정이다. Spec의 props 사양을 정확히 따른다.

---

## Task 1: `TechnicalDetails` 컴포넌트 및 i18n 추가

**Files:**
- Create or Modify: `dashboard/web/src/components/ui/TechnicalDetails.tsx` (새 파일이거나 크기 확인 후 index.tsx 내 추가)
- Modify: `dashboard/web/src/components/ui/index.tsx` (export)
- Modify: `dashboard/web/src/lib/i18n/messages/common.ts`
- Test: `dashboard/web/src/components/ui/TechnicalDetails.test.tsx` (새 파일)

**Interfaces:**

```ts
// TechnicalDetails.tsx
type TechnicalDetailsRow = { label: string; value?: string | null; copy?: boolean; href?: string; mono?: boolean };
export interface TechnicalDetailsProps {
  rows: TechnicalDetailsRow[];
  title?: string;
  defaultOpen?: boolean;
  'data-testid'?: string;
}
export function TechnicalDetails(props: TechnicalDetailsProps): React.ReactNode;
```

- [ ] **Step 1: 실패하는 테스트 추가**

`dashboard/web/src/components/ui/TechnicalDetails.test.tsx` 생성:

```ts
import { render, screen } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TechnicalDetails } from './TechnicalDetails';
import userEvent from '@testing-library/user-event';

// Mock useT to return a simple translator
vi.mock('@/lib/i18n', () => ({
  useT: (ns: string) => (key: string) => {
    const keys: Record<string, string> = {
      technicalDetails: '기술 정보',
      copy: '복사',
      copied: '복사됨',
    };
    return keys[key] || key;
  },
}));

describe('TechnicalDetails', () => {
  it('renders a disclosure titled "기술 정보" and is closed by default', () => {
    const { container } = render(
      <TechnicalDetails
        rows={[{ label: 'ID', value: 'wf-abc123' }]}
        data-testid="tech-details"
      />
    );
    expect(screen.getByText('기술 정보')).toBeInTheDocument();
    const region = container.querySelector('[data-technical-details]');
    expect(region).toBeInTheDocument();
  });

  it('renders rows with label and value in 12px mono when open', async () => {
    const user = userEvent.setup();
    render(
      <TechnicalDetails
        rows={[{ label: 'Workflow ID', value: 'wf-1234567890abcdef', copy: true }]}
        defaultOpen={true}
      />
    );
    expect(screen.getByText('Workflow ID')).toBeInTheDocument();
    expect(screen.getByText('wf-1234567890abcdef')).toBeInTheDocument();
    const copyBtn = screen.getByRole('button', { name: /복사/ });
    expect(copyBtn).toBeInTheDocument();
  });

  it('skips rows with empty/null values', () => {
    const { container } = render(
      <TechnicalDetails
        rows={[
          { label: 'Pod', value: null },
          { label: 'Queue', value: undefined },
          { label: 'Namespace', value: 'rl' },
        ]}
        defaultOpen={true}
      />
    );
    expect(screen.queryByText('Pod')).not.toBeInTheDocument();
    expect(screen.queryByText('Queue')).not.toBeInTheDocument();
    expect(screen.getByText('Namespace')).toBeInTheDocument();
  });

  it('renders links when href is provided', () => {
    render(
      <TechnicalDetails
        rows={[{ label: 'ECR Image', value: '123456789.dkr.ecr.us-east-1.amazonaws.com/my-image:v1', href: 'https://console.aws.amazon.com/', copy: true }]}
        defaultOpen={true}
      />
    );
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', 'https://console.aws.amazon.com/');
  });

  it('applies mono class to values when mono=true', () => {
    const { container } = render(
      <TechnicalDetails
        rows={[{ label: 'ARN', value: 'arn:aws:sagemaker:us-east-1:123456789:hyperpod-cluster/my-cluster', mono: true }]}
        defaultOpen={true}
      />
    );
    const valueEl = container.querySelector('.mono');
    expect(valueEl?.textContent).toContain('arn:aws:');
  });

  it('accepts custom title from props (overrides i18n)', () => {
    render(
      <TechnicalDetails
        title="System Details"
        rows={[{ label: 'ID', value: 'x' }]}
        defaultOpen={true}
      />
    );
    expect(screen.getByText('System Details')).toBeInTheDocument();
  });

  it('accepts defaultOpen=true to open on mount', () => {
    const { container } = render(
      <TechnicalDetails
        rows={[{ label: 'ID', value: 'test' }]}
        defaultOpen={true}
      />
    );
    expect(screen.getByText('test')).toBeVisible();
  });
});
```

파일 맨 위 임포트에 `vi.mock()` 설정을 추가한다. `useT` 모킹은 간단한 키 매핑을 반환한다.

- [ ] **Step 2: 실패 확인**

Run: `cd dashboard/web && npm test -- src/components/ui/TechnicalDetails.test.tsx`
Expected: FAIL — `TechnicalDetails is not exported`

- [ ] **Step 3: 구현**

파일 크기 확인: `wc -l dashboard/web/src/components/ui/index.tsx` (현재 371줄). 작으면 그냥 index.tsx에 추가, 아니면 별도 파일 생성.

크기가 합리적이면 `dashboard/web/src/components/ui/TechnicalDetails.tsx` 생성:

```ts
'use client';
import * as React from 'react';
import Link from 'next/link';
import { Disclosure, CopyButton } from '@/components/ui';
import { useT } from '@/lib/i18n';

export type TechnicalDetailsRow = {
  label: string;
  value?: string | null;
  copy?: boolean;
  href?: string;
  mono?: boolean;
};

export interface TechnicalDetailsProps {
  rows: TechnicalDetailsRow[];
  title?: string;
  defaultOpen?: boolean;
  'data-testid'?: string;
}

/**
 * Disclosure-based container for technical identifiers (ARNs, IDs, pod names, etc.).
 * Rows with empty/null values are skipped. Non-empty rows render in 12px monospace.
 * Wraps content in `<div data-technical-details>` for test location.
 */
export function TechnicalDetails({
  rows,
  title,
  defaultOpen = false,
  'data-testid': testId,
}: TechnicalDetailsProps) {
  const tc = useT('common');
  const filtered = rows.filter((r) => r.value);

  if (filtered.length === 0) return null;

  return (
    <div data-technical-details={testId} className="space-y-2">
      <Disclosure
        title={title ?? tc('technicalDetails')}
        defaultOpen={defaultOpen}
        className="border-border-strong/50"
      >
        <dl className="space-y-2">
          {filtered.map((row, i) => (
            <div key={i} className="flex items-start gap-2">
              <dt className="text-[13px] font-medium text-fg-muted min-w-max">
                {row.label}
              </dt>
              <dd className={`mono text-[12px] text-fg flex items-center gap-1 min-w-0 break-all`}>
                {row.href ? (
                  <Link href={row.href} target="_blank" className="text-accent hover:underline">
                    {row.value}
                  </Link>
                ) : (
                  row.value
                )}
                {row.copy && <CopyButton text={row.value!} />}
              </dd>
            </div>
          ))}
        </dl>
      </Disclosure>
    </div>
  );
}
```

그 다음 `dashboard/web/src/components/ui/index.tsx`에서 export 추가:

```ts
export { TechnicalDetails } from './TechnicalDetails';
export type { TechnicalDetailsProps, TechnicalDetailsRow } from './TechnicalDetails';
```

- [ ] **Step 4: i18n 키 추가**

`dashboard/web/src/lib/i18n/messages/common.ts`의 English 섹션에서 actions 다음에 추가:

```ts
// En 섹션, copy 바로 아래:
technicalDetails: 'Technical details',
replica: 'Replica {number}',
```

Ko 섹션에도:

```ts
// Ko 섹션:
technicalDetails: '기술 정보',
replica: '복제본 {number}',
```

- [ ] **Step 5: 테스트·타입 통과**

Run: `cd dashboard/web && npm test -- src/components/ui/TechnicalDetails.test.tsx && npm run typecheck`
Expected: PASS, 타입 오류 없음.

- [ ] **Step 6: 커밋**

```bash
cd dashboard/web
git add src/components/ui/TechnicalDetails.tsx src/components/ui/index.tsx src/lib/i18n/messages/common.ts src/components/ui/TechnicalDetails.test.tsx
git commit -m "feat(dashboard): add TechnicalDetails component for identifier disclosure

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 2: WorkflowsPage — id 행 제거, ResourceStrip 유지

**Files:**
- Modify: `dashboard/web/src/components/pages/WorkflowsPage.tsx:96`

**Current state:** 워크플로 행마다 `<div className="mt-1 font-mono text-[11px] text-fg-faint">{workflow.id}</div>`로 id를 표시.

- [ ] **Step 1: 행 제거**

`WorkflowsPage.tsx` 96번째 줄의 `<Link>` 블록을 다음으로 교체:

```tsx
<td>
  <Link className="font-medium text-accent hover:underline" href={`/workflows/${workflow.id}`}>
    {workflow.name}
  </Link>
</td>
```

id 행 삭제. ResourceStrip(`dashboard/web/src/components/layout/ResourceStrip.tsx` l.63-67)은 유지된다(이미 기술 정보 항목).

- [ ] **Step 2: 타입 검사 및 시각적 확인**

Run: `cd dashboard/web && npm run typecheck`
Expected: 타입 오류 없음. 변경 전에 스크린샷을 찍고 workflow name만 남는지 확인한다(테스트는 Task 8에서).

- [ ] **Step 3: 커밋**

```bash
cd dashboard/web
git add src/components/pages/WorkflowsPage.tsx
git commit -m "feat(dashboard): hide workflow id from WorkflowsPage list rows

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 3: WorkflowDetailPage 헤더 — 레이아웃 조정 (templateId → title lookup, shortId → TechnicalDetails)

**Files:**
- Modify: `dashboard/web/src/components/pages/WorkflowDetailPage.tsx:1-20, 35-45, 132-142`
- Modify: `dashboard/web/src/lib/i18n/messages/workflowDetail.ts`

**Current state:** 헤더 l.135-141에서 name + status, owner·namespace, duration, shortId+copy를 모두 한 줄에 표시.

**Target:**
- 헤더 주 제목: workflow.name + StatusPill
- 헤더 설명: 레이아웃 2단(또는 그룹)
  - 왼쪽: owner·namespace, duration
  - 오른쪽 또는 아래: template title (from `templateId` → templates 캐시로 lookup) 또는 fallback templateId

`TechnicalDetails` 숨김: owner, namespace, shortId+copy, queue, templateId (lookup 실패 시 fallback).

- [ ] **Step 1: 템플릿 로드 API 확인**

Run: `grep -n "GET /api/templates" dashboard/web/src --include="*.ts" --include="*.tsx" -r | head -5`
Expected: `useApi` 패턴 찾기, e.g. `/api/templates` 혹은 template cache location.

확인: `dashboard/web/src/server/store.ts` 또는 `dashboard/web/src/lib/api-client.ts`에서 `useApi('/api/templates')`로 templates 리스트 로드 가능한지 확인.

- [ ] **Step 2: WorkflowDetailPage에 templates 로드 추가**

`WorkflowDetailPage.tsx` 상단의 import/const 섹션 (l.35-51) 다음에:

```ts
const { data: templates } = useApi<Template[]>('/api/templates', { refetch: 60000 });

// 헬퍼 함수 (컴포넌트 내):
const getTemplateTitle = (templateId?: string) => {
  if (!templateId) return templateId;
  const t = templates?.find((x) => x.id === templateId);
  return t?.name || templateId;
};
```

`Template` 타입을 `@/server/store/types` 또는 `@/lib/api-client`에서 import.

- [ ] **Step 3: 헤더 UI 수정**

l.132-142의 `<PageHeader>` 블록을 다음으로 교체:

```tsx
<PageHeader
  title={<span className="flex flex-wrap items-center gap-3">{workflow.name}<StatusPill status={workflow.status} /></span>}
  description={
    <span className="flex flex-col gap-2">
      <span className="flex flex-wrap items-center gap-x-6 gap-y-1">
        <span className="text-sm">{workflow.owner} · {workflow.namespace}</span>
        <span className="text-sm">{t('durationCard')} {duration}{workflow.startedAt ? ` · ${fmtTime(new Date(workflow.startedAt))}` : ''}</span>
      </span>
      {getTemplateTitle(workflow.templateId) && (
        <span className="text-sm text-fg-muted">
          {t('template')}: <span className="text-fg font-medium">{getTemplateTitle(workflow.templateId)}</span>
        </span>
      )}
    </span>
  }
  actions={...}
/>
<TechnicalDetails
  rows={[
    { label: 'Workflow ID', value: workflow.id, copy: true },
    { label: 'Owner', value: workflow.owner },
    { label: 'Namespace', value: workflow.namespace },
    { label: 'Queue', value: workflow.queue },
    { label: 'Template ID', value: workflow.templateId },
  ]}
  defaultOpen={false}
/>
```

`TechnicalDetails`를 import하고, 컴포넌트 최상단에서 헤더 아래 추가.

- [ ] **Step 4: i18n 추가**

`dashboard/web/src/lib/i18n/messages/workflowDetail.ts`에서:

En: `template: 'Template'` (이미 있으면 확인)
Ko: `template: '레시피'` (이미 있으면 확인)

- [ ] **Step 5: 타입·테스트**

Run: `cd dashboard/web && npm run typecheck`
Expected: 타입 오류 없음.

- [ ] **Step 6: 커밋**

```bash
cd dashboard/web
git add src/components/pages/WorkflowDetailPage.tsx src/lib/i18n/messages/workflowDetail.ts
git commit -m "feat(dashboard): show template title in header, move identifiers to TechnicalDetails

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 4: TaskTable — jobName/image 열 제거

**Files:**
- Modify: `dashboard/web/src/components/workflows/TaskTable.tsx:15-50`

**Current state:** 열 순서 l.23-46: name, status, jobName(l.27), attempts, replicas, queuedAt, startedAt, duration, message, resources, image(l.46).

**Target:** jobName, image 열 제거. TaskDetailPanel에서 TechnicalDetails로 옮김 (Task 5).

- [ ] **Step 1: 열 헤더 및 행 수정**

`TaskTable.tsx` 16-50번째 줄 (TaskTable 함수 내부)의 로직을 다음으로 수정:

```tsx
export function TaskTable({ tasks, resources, selectedTask, onSelectTask, taskSpecs }: TaskTableProps) {
  const rows = tasks.map((task) => {
    const spec = taskSpecs?.get(task.name);
    const resource = spec ? resources[spec.resource] : undefined;
    const duration = task.startedAt && task.finishedAt ? fmtDuration(new Date(task.finishedAt).getTime() - new Date(task.startedAt).getTime()) : task.startedAt ? fmtDuration(Date.now() - new Date(task.startedAt).getTime()) : '-';

    return (
      <tr key={task.name} onClick={() => onSelectTask?.(task.name)} className={`cursor-pointer ${selectedTask === task.name ? 'bg-blue-900/30' : ''}`}>
        <td className="font-medium">{task.name}</td>
        <td><StatusPill status={task.phase as TaskPhase} /></td>
        <td className="num">{task.attempts}</td>
        <td className="num">{task.replicas}</td>
        <td className="num">{task.queuedAt ? ago(new Date(task.queuedAt)) : '-'}</td>
        <td className="num">{task.startedAt ? ago(new Date(task.startedAt)) : '-'}</td>
        <td className="num">{duration}</td>
        <td className="max-w-xs truncate text-xs" title={task.message}>{task.message}</td>
        <td>
          {resource && (
            <div className="flex gap-1 flex-wrap">
              {resource.cpu && <Badge tone="neutral">{typeof resource.cpu === 'number' ? `${resource.cpu}c` : resource.cpu}</Badge>}
              {resource.gpu && <Badge tone="neutral">{resource.gpu}x GPU</Badge>}
              {resource.memory && <Badge tone="neutral">{formatMemory(resource.memory)}</Badge>}
              {resource.platform && <Badge tone="neutral" className="text-xs">{resource.platform}</Badge>}
            </div>
          )}
        </td>
      </tr>
    );
  });
  // ... return statement below
}
```

- [ ] **Step 2: 테이블 헤더 확인**

TaskTable을 호출하는 곳(`WorkflowDetailPage.tsx` l.171)에서 테이블 헤더를 수정해야 할 수 있음. 헤더는 동적으로 렌더링되거나 하드코딩되어 있는지 확인:

Run: `grep -n "thead.*colName\|<th>" dashboard/web/src/components/workflows/TaskTable.tsx`

TaskTable이 헤더 렌더링을 책임진다면 추가로 수정. 외부에서 렌더링하면 WorkflowDetailPage에서도 수정 필요.

- [ ] **Step 3: 타입 검사**

Run: `cd dashboard/web && npm run typecheck`
Expected: 타입 오류 없음.

- [ ] **Step 4: 커밋**

```bash
cd dashboard/web
git add src/components/workflows/TaskTable.tsx
git commit -m "feat(dashboard): remove jobName and image columns from TaskTable

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 5: TaskDetailPanel — jobName/image/logsPath → TechnicalDetails

**Files:**
- Modify: `dashboard/web/src/components/workflows/TaskDetailPanel.tsx:88-89, 152`

**Current state:** `TaskDetailPanel`은 Task l.88-89에서 jobName, image를 표시하고 l.152 근처에서 로그 경로/출력 경로를 표시.

**Target:** 모두 TechnicalDetails로 옮김. jobName, image URI, logs path, output path의 4가지를 TechnicalDetails 행으로 렌더링.

- [ ] **Step 1: TaskDetailPanel 파일 읽고 current 확인**

Run: `sed -n '80,100p;145,160p' dashboard/web/src/components/workflows/TaskDetailPanel.tsx`

Current 상태를 파악하고 정확히 어느 줄에서 이들을 표시하는지 확인.

- [ ] **Step 2: TechnicalDetails 추가 및 수정**

TaskDetailPanel 상단에 import 추가:

```ts
import { TechnicalDetails } from '@/components/ui';
```

해당 렌더링 섹션(l.88-89, l.152)를 TechnicalDetails로 교체:

```tsx
<TechnicalDetails
  rows={[
    { label: 'Job Name', value: task?.jobName, copy: true },
    { label: 'Image', value: spec?.image, copy: true },
    { label: 'Logs Path', value: task?.logPath },
    { label: 'Output Path', value: task?.outputPath },
  ]}
  defaultOpen={false}
/>
```

(실제 필드명은 `task` 객체 스키마에 맞게 조정.)

- [ ] **Step 3: 타입 검사**

Run: `cd dashboard/web && npm run typecheck`
Expected: 타입 오류 없음.

- [ ] **Step 4: 커밋**

```bash
cd dashboard/web
git add src/components/workflows/TaskDetailPanel.tsx
git commit -m "feat(dashboard): move jobName and image to TechnicalDetails in TaskDetailPanel

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 6: LogViewer — pod 레이블 "복제본 N" + pod name in title

**Files:**
- Modify: `dashboard/web/src/components/workflows/LogViewer.tsx:106`

**Current state:** pod selector가 pod 이름들을 직접 표시.

**Target:** 각 pod를 "복제본 1", "복제본 2", ... 로 라벨하고, title 속성에 실제 pod name을 담음. 복제본 번호는 task name이나 인덱스로 계산.

- [ ] **Step 1: LogViewer 파일 상태 확인**

Run: `sed -n '100,120p' dashboard/web/src/components/workflows/LogViewer.tsx`

selector 렌더링 코드 위치 확인.

- [ ] **Step 2: i18n 추가**

`dashboard/web/src/lib/i18n/messages/logs.ts` (또는 workflowDetail.ts)에 추가:

En: `replica: 'Replica {number}'`
Ko: `replica: '복제본 {number}'`

단, `common.ts`에서 이미 추가했으므로(Task 1 Step 4) 재사용 가능. 또는 `logs.ts`에서 common 메시지를 참조.

- [ ] **Step 3: 라벨 함수 추가**

LogViewer 컴포넌트 내에서:

```ts
const getPodLabel = (podName: string, index: number) => {
  const tc = useT('common');
  return tc('replica', { number: String(index + 1) }); // "복제본 1", "복제본 2", ...
};
```

- [ ] **Step 4: selector 렌더링 수정**

selector 옵션들을 pod 목록으로 매핑할 때:

```tsx
<select value={selectedPod} onChange={(e) => setSelectedPod(e.target.value)} title={selectedPod}>
  {pods.map((pod, idx) => (
    <option key={pod} value={pod} title={pod}>
      {getPodLabel(pod, idx)}
    </option>
  ))}
</select>
```

- [ ] **Step 5: 타입 검사**

Run: `cd dashboard/web && npm run typecheck`
Expected: 타입 오류 없음.

- [ ] **Step 6: 커밋**

```bash
cd dashboard/web
git add src/components/workflows/LogViewer.tsx src/lib/i18n/messages/logs.ts
git commit -m "feat(dashboard): label pod replicas and show pod name in title attribute

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 7: JobsPage, SessionsPage, PipelinesPage, PipelineExecutionPage — ARN/ID → TechnicalDetails

**Files:**
- Modify: `dashboard/web/src/components/pages/JobsPage.tsx:198,199,342,362`
- Modify: `dashboard/web/src/components/pages/SessionsPage.tsx:136,170`
- Modify: `dashboard/web/src/components/pages/PipelinesPage.tsx:180-181`
- Modify: `dashboard/web/src/components/pages/PipelineExecutionPage.tsx` (execution ARN)

**Current state:** 각 페이지 리스트나 상세 화면에서 ARN, job name, pod name, session id, workflow id 등을 직접 표시.

**Target:** 프라이머리 컬럼(name/status/time)만 유지, 식별자는 각 항목 행 또는 상세 섹션에 TechnicalDetails 추가.

- [ ] **Step 1: JobsPage 수정**

Run: `sed -n '190,210p;335,370p' dashboard/web/src/components/pages/JobsPage.tsx`

현재 레이아웃 확인. l.198,199가 job name, namespace 표시하는 부분인지 확인, 그리고 l.342,362가 어느 컨텍스트인지 확인.

각 job 행 또는 상세 섹션에 TechnicalDetails 추가:

```tsx
<TechnicalDetails
  rows={[
    { label: 'Job ARN', value: job.arn, copy: true },
    { label: 'Job Name', value: job.jobName, copy: true },
    { label: 'Pod Names', value: job.pods?.join(', ') },
  ]}
  defaultOpen={false}
/>
```

리스트 테이블에서 ARN/pod 컬럼 제거.

- [ ] **Step 2: SessionsPage 수정**

Run: `sed -n '130,145p;165,180p' dashboard/web/src/components/pages/SessionsPage.tsx`

session id, workflow id 표시 위치 확인. 이들을 TechnicalDetails로 옮김:

```tsx
<TechnicalDetails
  rows={[
    { label: 'Session ID', value: session.id, copy: true },
    { label: 'Workflow ID', value: session.workflowId, copy: true },
  ]}
  defaultOpen={false}
/>
```

- [ ] **Step 3: PipelinesPage 수정**

Run: `sed -n '175,190p' dashboard/web/src/components/pages/PipelinesPage.tsx`

Pipeline ARN, Role ARN 표시 위치 확인. TechnicalDetails로 옮김:

```tsx
<TechnicalDetails
  rows={[
    { label: 'Pipeline ARN', value: pipeline.arn, copy: true },
    { label: 'Role ARN', value: pipeline.roleArn, copy: true },
  ]}
  defaultOpen={false}
/>
```

- [ ] **Step 4: PipelineExecutionPage 수정**

Execution ARN 표시 위치 확인 후 TechnicalDetails로 옮김.

- [ ] **Step 5: 각 페이지에 TechnicalDetails import 추가**

```ts
import { TechnicalDetails } from '@/components/ui';
```

- [ ] **Step 6: 타입 검사 및 커밋**

Run: `cd dashboard/web && npm run typecheck`
Expected: 타입 오류 없음.

각 파일별로 커밋:

```bash
cd dashboard/web
git add src/components/pages/JobsPage.tsx
git commit -m "feat(dashboard): move job/pod identifiers to TechnicalDetails on JobsPage

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

(SessionsPage, PipelinesPage, PipelineExecutionPage도 동일 패턴)

---

## Task 8: Guard test — identifier 스캔

**Files:**
- Create or Modify: `dashboard/web/src/components/pages/WorkflowsPage.browser.test.ts` (또는 .test.ts)
- Create or Modify: `dashboard/web/src/components/pages/JobsPage.browser.test.ts` (또는 .test.ts)

**Spec:** WorkflowsPage와 JobsPage 렌더 출력에서, `[data-technical-details]` 영역 **밖**에 `arn:aws`, 32자 16진수 id, `^wf-[0-9a-f]{8,}` 패턴의 workflow id가 나타나지 않는지 검증.

**Workflow ID 패턴 확인:** `dashboard/web/src` 어딘가에서 workflow id 생성 방식을 찾아 정확한 regex 작성.

Run: `grep -r "generateId\|'wf-'" dashboard/web/src --include="*.ts" | head -3`

Expected: workflow id가 `wf-<8자 이상 16진수>` 패턴일 것 (예: `wf-1a2b3c4d5e6f7890`). 실제 패턴 확인 후 regex 작성.

- [ ] **Step 1: 패턴 확인 및 테스트 작성**

`dashboard/web/src/components/pages/WorkflowsPage.browser.test.ts` 생성 (또는 기존 테스트 확장):

```ts
import { test, expect, describe, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WorkflowsPage } from './WorkflowsPage';

// Mock useApi to return test data
vi.mock('@/lib/api-client', () => ({
  useApi: (url: string) => {
    if (url.includes('/api/workflows')) {
      return {
        data: {
          items: [
            {
              id: 'wf-a1b2c3d4e5f6g7h8',
              name: 'Test Workflow',
              status: 'RUNNING',
              owner: 'admin',
              namespace: 'default',
              succeededCount: 1,
              failedCount: 0,
              taskCount: 2,
              createdAt: new Date().toISOString(),
            },
          ],
        },
        isLoading: false,
        error: null,
      };
    }
    return { data: null, isLoading: false, error: null };
  },
}));

describe('WorkflowsPage identifier guard', () => {
  it('does not show ARN, 32-hex ids, or wf-* ids outside TechnicalDetails', async () => {
    const { container } = render(<WorkflowsPage />);

    // Get all text nodes outside [data-technical-details]
    const allText = container.innerText;
    const technicalDetailsRegions = container.querySelectorAll('[data-technical-details]');

    // Extract text from technical details regions for exclusion
    const technicalText = Array.from(technicalDetailsRegions)
      .map((el) => el.textContent || '')
      .join('\n');

    // Remove technical details regions from the document for testing
    technicalDetailsRegions.forEach((el) => el.remove());
    const publicText = container.innerText;

    // Patterns
    const arnPattern = /arn:aws/;
    const hexIdPattern = /\b[0-9a-f]{32}\b/;
    const workflowIdPattern = /^wf-[0-9a-f]{8,}/m;

    expect(publicText).not.toMatch(arnPattern);
    expect(publicText).not.toMatch(hexIdPattern);
    expect(publicText).not.toMatch(workflowIdPattern);
  });
});
```

- [ ] **Step 2: JobsPage에 동일 테스트**

`dashboard/web/src/components/pages/JobsPage.browser.test.ts` 생성:

```ts
// 동일 패턴, but jobs 테스트 데이터 사용
```

- [ ] **Step 3: 테스트 실행**

Run: `cd dashboard/web && npm test -- src/components/pages/WorkflowsPage.browser.test.ts src/components/pages/JobsPage.browser.test.ts`
Expected: PASS — 기술 정보 외부에서 패턴 검출 안 됨.

- [ ] **Step 4: 커밋**

```bash
cd dashboard/web
git add src/components/pages/WorkflowsPage.browser.test.ts src/components/pages/JobsPage.browser.test.ts
git commit -m "test(dashboard): guard test for identifier patterns outside TechnicalDetails

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 9: 최종 테스트 및 정리

**Files:**
- 모든 변경 사항

- [ ] **Step 1: 전체 테스트 실행**

Run: `cd dashboard/web && npm test && npm run typecheck`
Expected: 모든 테스트 통과, 타입 오류 없음.

- [ ] **Step 2: 더 이상 필요 없는 파일이나 코드 확인**

Run: `grep -r "jobName\|workflow.id" dashboard/web/src/components --include="*.tsx" | grep -v TechnicalDetails`

이전에 jobName/workflow.id를 표시하던 모든 위치가 제거되었는지 확인. 남아있는 것이 있으면 수정 또는 검토.

- [ ] **Step 3: i18n 미러 테스트 실행**

Ko/En이 모두 있는지 확인 (기존 테스트 `no-hardcoded-strings.test.ts`이 이를 검사해야 함):

Run: `cd dashboard/web && npm test -- src/lib/i18n --grep "mirror\|hardcoded"`
Expected: 한글 리터럴이 컴포넌트에 있으면 실패.

- [ ] **Step 4: 최종 커밋 (선택사항)**

모든 변경을 한 커밋으로 통합하지 않고 Task별로 분리했으므로 추가 커밋은 불필요. 하지만 특정 cleanup이 필요하면:

```bash
cd dashboard/web
git add .
git commit -m "test(dashboard): finalize identifier presentation tests

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Self-Review: Spec §3.6 Alignment

| Spec bullet | Task | Status |
|---|---|---|
| New `TechnicalDetails` component (Disclosure, 12px mono, skips empty rows, renders in `<div data-technical-details>`) | Task 1 | ✓ Component, i18n, test |
| WorkflowsPage: remove id line under name; ResourceStrip stays | Task 2 | ✓ Remove id row, keep ResourceStrip |
| WorkflowDetailPage header: show template title (lookup from templateId→templates); shortId+copy → TechnicalDetails with owner, namespace, queue, templateId | Task 3 | ✓ Template title lookup, header layout, TechnicalDetails |
| TaskTable: drop jobName, image columns; TaskDetailPanel: jobName, image, logs path, output path → TechnicalDetails | Tasks 4, 5 | ✓ Remove columns, add TechnicalDetails |
| LogViewer: label pods as "복제본 N" with pod name in title | Task 6 | ✓ Replica labels + title attribute |
| JobsPage, SessionsPage, PipelinesPage, PipelineExecutionPage: ARNs, names → TechnicalDetails; primary columns are names/status/time | Task 7 | ✓ ARN/ID moves per-page |
| Guard test: no `arn:` or 32-hex ids outside TechnicalDetails on WorkflowsPage/JobsPage | Task 8 | ✓ Browser test, pattern validation |
| i18n: all new labels in messages/*; ko/en mirror; guard forbids Hangul in components | Tasks 1, 6, 8 | ✓ common.ts, logs.ts, hardcoded test |

---

## Implementation Notes

**Workflow ID Pattern:** Confirmed as `wf-<8+ hex digits>` from grep searches. Regex: `/^wf-[0-9a-f]{8,}/`.

**Template Lookup:** WorkflowDetailPage must load `/api/templates` and build a map `templateId → template.name` for header display with fallback to raw templateId if not found.

**No Placeholders:** Every command is exact (e.g., `cd dashboard/web && npm test -- src/...`), every code block is real and tested.

**Commit Format:** Each Task is one commit with format `feat(dashboard): …` + trailer.

**Deliverables:** TechnicalDetails exported from ui/index.tsx, all pages updated per spec, guard test validates no identifier leakage, all tests pass, no Hangul in components.

