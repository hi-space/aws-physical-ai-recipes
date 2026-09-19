# Dashboard B — DynamoDB 로그 아카이브 제거, kubelet 스트림 단일 경로 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** controller가 Pod 로그를 DynamoDB에 저장하는 경로를 완전히 제거하고, 워크플로 태스크·K8s Pod 로그를 Kubernetes API에서 직접 읽어 JSON 스냅샷 또는 SSE로 제공한다. 프로젝트 권한 검사와 비밀값 redaction은 유지한다.

**Architecture:** 새 모듈 `server/logs/stream.ts`가 (workflow, task) → Pod 목록(`LogTarget[]`) 해석과 kubelet 읽기·follow를 담당한다. `server/logs/http.ts`는 이를 감싸 권한·redaction·SSE 프레이밍만 한다. 아카이브·수집기·커서·클라이언트 재생 프로토콜·CLI 커서는 삭제한다. 기존 DDB `LOG#*` 아이템은 TTL로 소멸한다.

**Tech Stack:** Next.js 16 route handlers, undici fetch(K8s API), vitest, Playwright(e2e), Python 3.11 stdlib CLI.

**Spec:** `docs/designs/2026-09-19-dashboard-modular-http-logs-design.md` §5

## Global Constraints

- 모든 명령은 `dashboard/web`(`npm test -- <file>`, `npm run typecheck`), `dashboard/cli`(`python3 -m unittest discover -s tests`)에서 실행.
- UI 문자열은 `web/src/lib/i18n/messages/*`의 `en`/`ko` 양쪽에 두고 컴포넌트에 한글 리터럴을 쓰지 않는다.
- 로그 상한: `tail` 기본 1,000·최대 5,000, 스냅샷 1 MiB, SSE 연결 55초 후 `end`, 클라이언트 표시 10,000줄.
- 시도별 Secret(`ensureAttemptSecret`)은 항상 생성한다(redaction 근거).
- 커밋 메시지 형식 `feat|fix|refactor|docs(dashboard): …`, 끝에 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- `infra/cdk.out*/asset.*` 아래 복사본은 빌드 산출물이므로 건드리지 않는다.

---

### Task 1: `logs/types.ts` 축소와 `logs/stream.ts` 신설

**Files:**
- Modify: `dashboard/web/src/server/logs/types.ts`
- Create: `dashboard/web/src/server/logs/stream.ts`
- Test: `dashboard/web/src/server/logs/stream.test.ts`
- Modify: `dashboard/web/src/server/k8s/resources.ts:182-190` (`podLogs`, `streamPodLogs`에 `sinceTime` 추가)

**Interfaces:**
- Produces:
```ts
// types.ts
export const LIMITS = { chunk: 16 * 1024, tailDefault: 1000, tailMax: 5000, snapshotBytes: 1024 * 1024, followMs: 55_000 } as const;
export interface LogTarget { namespace: string; podName: string; podUid: string; attempt: number; member: number; containers: string[]; phase?: string }
export interface LogLine { ts: string; text: string }
export interface LogSnapshot { source: 'kubernetes' | 'none'; reason?: 'pod-gone' | 'not-started'; phase?: string; target?: LogTarget; container?: string; targets: LogTarget[]; lines: LogLine[]; truncated: boolean; redaction: 'applied' | 'unavailable' | 'none' }
export interface LogDeps { repo: Repo; now?: () => number; currentUser?: (username: string) => Promise<CurrentUserAuthorization> }
// stream.ts
export function targetsFromPods(pods: Pod[]): LogTarget[]
export async function resolveTargets(workflow: Workflow, taskName: string, list?: typeof listPods): Promise<LogTarget[]>
export function pickTarget(targets: LogTarget[], want: { attempt?: number; member?: number }): LogTarget | undefined
export function pickContainer(target: LogTarget, want?: string): string
export function splitLogLines(text: string): LogLine[]
export async function readLogs(target: LogTarget, container: string, opts: { tail?: number; sinceTime?: string; redactor?: SecretRedactor; read?: typeof podLogs }): Promise<{ lines: LogLine[]; truncated: boolean }>
export async function* followLogs(target: LogTarget, container: string, opts: { tail?: number; sinceTime?: string; redactor?: SecretRedactor; signal: AbortSignal; open?: typeof streamPodLogs }): AsyncGenerator<LogLine>
```

- [ ] **Step 1: `types.ts`를 위 내용으로 교체**

```ts
import type { Repo } from '../store/repo';
import type { CurrentUserAuthorization } from '../aws/cognito';
export const LIMITS = { chunk: 16 * 1024, tailDefault: 1000, tailMax: 5000, snapshotBytes: 1024 * 1024, followMs: 55_000 } as const;
export interface LogTarget { namespace: string; podName: string; podUid: string; attempt: number; member: number; containers: string[]; phase?: string }
export interface LogLine { ts: string; text: string }
export interface LogSnapshot {
  source: 'kubernetes' | 'none'; reason?: 'pod-gone' | 'not-started'; phase?: string;
  target?: LogTarget; container?: string; targets: LogTarget[]; lines: LogLine[]; truncated: boolean;
  redaction: 'applied' | 'unavailable' | 'none';
}
export interface LogDeps { repo: Repo; now?: () => number; currentUser?: (username: string) => Promise<CurrentUserAuthorization> }
```
`redaction.ts`는 `LIMITS.chunk`만 쓰므로 그대로 컴파일된다.

- [ ] **Step 2: 실패하는 테스트 작성** — `stream.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { SecretRedactor } from './redaction';
import { followLogs, pickContainer, pickTarget, readLogs, splitLogLines, targetsFromPods } from './stream';
import type { Pod } from '../k8s/resources';

const pod = (name: string, attempt: number, member = 0, uid = `${name}-uid`, phase = 'Running'): Pod => ({
  metadata: { name, namespace: 'team', uid, labels: { 'app.kubernetes.io/managed-by': 'physical-ai-dashboard', 'pai.aws/workflow-id': 'w1', 'pai.aws/task': 'train', 'pai.aws/attempt': String(attempt), 'batch.kubernetes.io/job-completion-index': String(member) } },
  spec: { containers: [{ name: 'main' }, { name: 'pai-live' }] } as Pod['spec'], status: { phase },
});
const stream = (chunks: string[]) => new ReadableStream<Uint8Array>({ start(c) { for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk)); c.close(); } });

describe('targets', () => {
  it('orders newest attempt first, members ascending, and lists containers', () => {
    const targets = targetsFromPods([pod('a1m1', 1, 1), pod('a2', 2), pod('a1m0', 1, 0)]);
    expect(targets.map(t => [t.attempt, t.member, t.podName])).toEqual([[2, 0, 'a2'], [1, 0, 'a1m0'], [1, 1, 'a1m1']]);
    expect(targets[0].containers).toEqual(['main', 'pai-live']);
  });
  it('picks the latest attempt / first member by default and honours explicit selection', () => {
    const targets = targetsFromPods([pod('a1m1', 1, 1), pod('a2', 2), pod('a1m0', 1, 0)]);
    expect(pickTarget(targets, {})?.podName).toBe('a2');
    expect(pickTarget(targets, { attempt: 1, member: 1 })?.podName).toBe('a1m1');
    expect(pickTarget(targets, { attempt: 9 })).toBeUndefined();
    expect(pickContainer(targets[0])).toBe('main');
    expect(pickContainer(targets[0], 'pai-live')).toBe('pai-live');
    expect(() => pickContainer(targets[0], 'nope')).toThrow(/Container/);
  });
});
describe('splitLogLines', () => {
  it('separates kubelet timestamps and keeps blank and repeated lines', () => {
    expect(splitLogLines('2026-09-19T01:02:03.000000001Z same\n2026-09-19T01:02:04Z same\n2026-09-19T01:02:05Z \nno-timestamp line\n')).toEqual([
      { ts: '2026-09-19T01:02:03.000000001Z', text: 'same' }, { ts: '2026-09-19T01:02:04Z', text: 'same' },
      { ts: '2026-09-19T01:02:05Z', text: '' }, { ts: '', text: 'no-timestamp line' }]);
  });
});
describe('readLogs', () => {
  const target = targetsFromPods([pod('p', 1)])[0];
  it('redacts exact secrets and passes tail/sinceTime to the kubelet read', async () => {
    const calls: unknown[] = [];
    const read = async (_ns: string, _pod: string, opts: unknown) => { calls.push(opts); return '2026-09-19T00:00:00Z token=SECRET-1\n'; };
    const result = await readLogs(target, 'main', { tail: 7, sinceTime: '2026-09-18T00:00:00Z', redactor: new SecretRedactor(['SECRET-1']), read });
    expect(result.lines).toEqual([{ ts: '2026-09-19T00:00:00Z', text: 'token=[REDACTED]' }]);
    expect(calls[0]).toMatchObject({ container: 'main', tailLines: 7, sinceTime: '2026-09-18T00:00:00Z' });
  });
  it('marks truncation when the snapshot exceeds the byte bound', async () => {
    const read = async () => `2026-09-19T00:00:00Z ${'x'.repeat(1024 * 1024)}\n2026-09-19T00:00:01Z tail\n`;
    const result = await readLogs(target, 'main', { read });
    expect(result.truncated).toBe(true);
    expect(result.lines.at(-1)?.text).toBe('tail');
  });
});
describe('followLogs', () => {
  const target = targetsFromPods([pod('p', 1)])[0];
  it('yields redacted lines across chunk boundaries and stops when the stream ends', async () => {
    const open = async () => stream(['2026-09-19T00:00:00Z a SEC', 'RET-1 b\n2026-09-19T00:00:01Z last']);
    const lines = [];
    for await (const line of followLogs(target, 'main', { redactor: new SecretRedactor(['SECRET-1']), signal: new AbortController().signal, open })) lines.push(line);
    expect(lines).toEqual([{ ts: '2026-09-19T00:00:00Z', text: 'a [REDACTED] b' }, { ts: '2026-09-19T00:00:01Z', text: 'last' }]);
  });
});
```

- [ ] **Step 3: 실패 확인**

Run: `cd dashboard/web && npm test -- src/server/logs/stream.test.ts`
Expected: FAIL — `./stream` 모듈 없음.

- [ ] **Step 4: `k8s/resources.ts`의 두 함수에 `sinceTime` 추가**

```ts
export async function podLogs(ns: string, pod: string, opts: { container?: string; tailLines?: number; sinceSeconds?: number; sinceTime?: string; previous?: boolean; limitBytes?: number } = {}): Promise<string> {
  const res = await k8sRequest(`/api/v1/namespaces/${ns}/pods/${pod}/log?${q({ container: opts.container, tailLines: opts.tailLines ?? 2000, sinceSeconds: opts.sinceSeconds, sinceTime: opts.sinceTime, limitBytes: opts.limitBytes, previous: opts.previous ? 'true' : undefined, timestamps: 'true' })}`, {
    headers: { accept: '*/*' },
  });
  return res.text();
}
export async function streamPodLogs(ns: string, pod: string, opts: { container?: string; tailLines?: number; sinceTime?: string; signal?: AbortSignal } = {}): Promise<ReadableStream<Uint8Array>> {
  const res = await k8sRequest(`/api/v1/namespaces/${ns}/pods/${pod}/log?${q({ container: opts.container, tailLines: opts.tailLines ?? 500, sinceTime: opts.sinceTime, follow: 'true', timestamps: 'true' })}`, { headers: { accept: '*/*' }, signal: opts.signal });
  return res.body as ReadableStream<Uint8Array>;
}
```

- [ ] **Step 5: `stream.ts` 구현**

```ts
import { listPods, podLogs, streamPodLogs, type Pod } from '../k8s/resources';
import type { Workflow } from '../store/types';
import { HttpError } from '../errors';
import type { SecretRedactor } from './redaction';
import { LIMITS, type LogLine, type LogTarget } from './types';

const TS = /^(\d{4}-\d{2}-\d{2}T[0-9:.]+Z) ?/;
export const taskSelector = (wf: Workflow, task: string) => `app.kubernetes.io/managed-by=physical-ai-dashboard,pai.aws/workflow-id=${wf.id},pai.aws/task=${task}`;

export function targetsFromPods(pods: Pod[]): LogTarget[] {
  return pods.filter(p => p.metadata.uid && p.metadata.labels?.['pai.aws/attempt']).map(p => ({
    namespace: p.metadata.namespace!, podName: p.metadata.name, podUid: p.metadata.uid!,
    attempt: Number(p.metadata.labels!['pai.aws/attempt']), member: Number(p.metadata.labels!['batch.kubernetes.io/job-completion-index'] ?? 0),
    containers: [...(p.spec.initContainers ?? []), ...p.spec.containers].map(c => c.name), phase: p.status?.phase,
  })).sort((a, b) => b.attempt - a.attempt || a.member - b.member);
}
export async function resolveTargets(workflow: Workflow, taskName: string, list: typeof listPods = listPods): Promise<LogTarget[]> {
  return targetsFromPods(await list(workflow.namespace, taskSelector(workflow, taskName)));
}
export function pickTarget(targets: LogTarget[], want: { attempt?: number; member?: number }): LogTarget | undefined {
  const attempt = want.attempt ?? targets[0]?.attempt, member = want.member ?? 0;
  return targets.find(t => t.attempt === attempt && t.member === member);
}
export function pickContainer(target: LogTarget, want?: string): string {
  const name = want ?? (target.containers.includes('main') ? 'main' : target.containers[0]);
  if (!name || !target.containers.includes(name)) throw new HttpError(404, 'Container not found', 'log_container_not_found');
  return name;
}
export function splitLogLines(text: string): LogLine[] {
  const rows = text.split('\n');
  if (rows.at(-1) === '') rows.pop();
  return rows.map(row => { const m = TS.exec(row); return m ? { ts: m[1], text: row.slice(m[0].length) } : { ts: '', text: row }; });
}
function bound(tail?: number) {
  const n = tail ?? LIMITS.tailDefault;
  if (!Number.isSafeInteger(n) || n < 1 || n > LIMITS.tailMax) throw new HttpError(400, `tail must be 1–${LIMITS.tailMax}`, 'log_tail_out_of_range');
  return n;
}
export async function readLogs(target: LogTarget, container: string, opts: { tail?: number; sinceTime?: string; redactor?: SecretRedactor; read?: typeof podLogs } = {}) {
  const raw = await (opts.read ?? podLogs)(target.namespace, target.podName, { container, tailLines: bound(opts.tail), sinceTime: opts.sinceTime, limitBytes: LIMITS.snapshotBytes + 1 });
  const text = opts.redactor ? Buffer.concat([opts.redactor.push(Buffer.from(raw)), opts.redactor.finish()]).toString('utf8') : raw;
  const truncated = Buffer.byteLength(raw) > LIMITS.snapshotBytes;
  const lines = splitLogLines(text);
  return { lines: truncated ? lines.slice(1) : lines, truncated };
}
export async function* followLogs(target: LogTarget, container: string, opts: { tail?: number; sinceTime?: string; redactor?: SecretRedactor; signal: AbortSignal; open?: typeof streamPodLogs }): AsyncGenerator<LogLine> {
  const body = await (opts.open ?? streamPodLogs)(target.namespace, target.podName, { container, tailLines: bound(opts.tail), sinceTime: opts.sinceTime, signal: opts.signal });
  const reader = body.getReader(), decoder = new TextDecoder();
  let pending = '';
  try {
    for (;;) {
      const next = await reader.read();
      const bytes = next.done ? (opts.redactor?.finish() ?? Buffer.alloc(0)) : opts.redactor ? opts.redactor.push(next.value) : Buffer.from(next.value);
      pending += decoder.decode(bytes, { stream: !next.done });
      const rows = pending.split('\n'); pending = next.done ? '' : rows.pop()!;
      for (const line of splitLogLines(rows.join('\n') + (rows.length ? '\n' : ''))) yield line;
      if (next.done) { if (pending) yield* splitLogLines(pending); return; }
    }
  } finally { await reader.cancel().catch(() => undefined); }
}
```

- [ ] **Step 6: 통과 확인**

Run: `cd dashboard/web && npm test -- src/server/logs/stream.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 7: 커밋**

```bash
git add dashboard/web/src/server/logs/types.ts dashboard/web/src/server/logs/stream.ts dashboard/web/src/server/logs/stream.test.ts dashboard/web/src/server/k8s/resources.ts
git commit -m "feat(dashboard): kubelet log target resolution and line streaming module

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `logs/http.ts` 재작성 — 권한·redaction·SSE

**Files:**
- Rewrite: `dashboard/web/src/server/logs/http.ts`
- Modify: `dashboard/web/src/server/logs/auth.ts` (scope 파라미터 제거)
- Rewrite: `dashboard/web/src/server/logs/http.test.ts`
- Modify: `dashboard/web/src/app/api/workflows/[id]/tasks/[task]/logs/route.ts:4`

**Interfaces:**
- Consumes: Task 1의 `resolveTargets`, `pickTarget`, `pickContainer`, `readLogs`, `followLogs`; 기존 `authorizeLogs(p, workflowId, taskName, deps)`; `injectedLogSecrets(workflow, task, pod, container)`.
- Produces:
```ts
export interface LogHttpDeps extends LogDeps { listPods?: typeof listPods; getPod?: typeof getPod; secrets?: typeof injectedLogSecrets; read?: typeof podLogs; open?: typeof streamPodLogs; authMs?: number; lifetimeMs?: number }
export async function taskLogResponse(req: Request, p: Session, workflowId: string, taskName: string, deps?: LogHttpDeps): Promise<Response>
export function sseResponse(lines: AsyncIterable<LogLine>, opts: { lifetimeMs: number; authMs: number; stop: AbortController; request: AbortSignal; reauth: () => Promise<void> }): Response
export async function redactorFor(wf: Workflow, task: Task | undefined, target: LogTarget, container: string, deps: LogHttpDeps): Promise<SecretRedactor | undefined>
```
- SSE 이벤트: `id: <ts>` + `event: line` + `data: {"ts","text"}`; 종료 `event: end` + `data: {"reason":"timeout"|"pod-ended"}`; 오류 `event: log-error` + `data: {"error","code"}`.
- 쿼리: `attempt`, `member`, `container`, `tail`, `since`(RFC3339), `follow=1`. `Last-Event-ID` 헤더가 있으면 `since`로 사용.

- [ ] **Step 1: `auth.ts`에서 scope 검사 제거**

`authorizeLogs` 시그니처를 `(p: Session, workflowId: string, taskName: string, deps: LogDeps)`로 바꾸고, `if (scope && (...)) throw fail();` 줄과 `LogScope` import를 삭제. 404 메시지를 `'Project workflow not found'`로. `principalBinding` export는 남겨도 되지만 사용처가 없으므로 삭제.

- [ ] **Step 2: 실패하는 테스트** — `http.test.ts` 전체 교체

```ts
import { describe, expect, it, vi } from 'vitest';
import { taskLogResponse } from './http';
import type { Session } from '../auth/session';
import type { Pod } from '../k8s/resources';

vi.mock('./auth', () => ({ authorizeLogs: vi.fn(async (_p, id) => ({ id, namespace: 'team', projectId: 'p1', spec: { workflow: { tasks: [{ name: 'train' }] } } })) }));
const session: Session = { user: 'u', subject: 's', email: 'e', role: 'researcher', authMethod: 'alb' };
const pod = (attempt: number, name = `p${attempt}`): Pod => ({ metadata: { name, namespace: 'team', uid: `${name}-uid`, labels: { 'pai.aws/attempt': String(attempt), 'pai.aws/task': 'train' } }, spec: { containers: [{ name: 'main' }] } as Pod['spec'], status: { phase: 'Running' } });
const task = { name: 'train', attempts: 2, attemptEpoch: 'e' };
const repo = { getWorkflow: async () => ({ id: 'w1', namespace: 'team' }), listTasks: async () => [task] } as never;
const request = (query: string, headers: Record<string, string> = {}) => new Request(`http://x/api/workflows/w1/tasks/train/logs?${query}`, { headers });
const base = { repo, getPod: async () => pod(2) };

describe('taskLogResponse JSON', () => {
  it('returns pod-gone when no pod exists for the task', async () => {
    const res = await taskLogResponse(request(''), session, 'w1', 'train', { ...base, listPods: async () => [] });
    expect(await res.json()).toMatchObject({ source: 'none', reason: 'pod-gone', targets: [], lines: [] });
  });
  it('reads the latest attempt with redaction from the attempt secret', async () => {
    const read = vi.fn(async () => '2026-09-19T00:00:00Z pw=S3CR3T\n');
    const res = await taskLogResponse(request('tail=50'), session, 'w1', 'train', { ...base, listPods: async () => [pod(1), pod(2)], secrets: async () => ['S3CR3T'], read });
    const body = await res.json();
    expect(body).toMatchObject({ source: 'kubernetes', redaction: 'applied', target: { attempt: 2 }, container: 'main', lines: [{ text: 'pw=[REDACTED]' }] });
    expect(body.targets).toHaveLength(2);
    expect(read.mock.calls[0][2]).toMatchObject({ tailLines: 50 });
  });
  it('reports redaction unavailable when the attempt secret cannot be verified', async () => {
    const res = await taskLogResponse(request(''), session, 'w1', 'train', { ...base, listPods: async () => [pod(2)], secrets: async () => { throw new Error('no secret'); }, read: async () => 'x\n' });
    expect(await res.json()).toMatchObject({ redaction: 'unavailable', lines: [{ text: 'x' }] });
  });
  it('rejects an out-of-range tail', async () => {
    const res = await taskLogResponse(request('tail=99999'), session, 'w1', 'train', { ...base, listPods: async () => [pod(2)] });
    expect(res.status).toBe(400);
  });
});
describe('taskLogResponse SSE', () => {
  const stream = (chunks: string[]) => new ReadableStream<Uint8Array>({ start(c) { for (const x of chunks) c.enqueue(new TextEncoder().encode(x)); c.close(); } });
  it('frames lines with the timestamp as id and ends with pod-ended when the kubelet stream closes', async () => {
    const res = await taskLogResponse(request('follow=1', { accept: 'text/event-stream' }), session, 'w1', 'train',
      { ...base, listPods: async () => [pod(2)], secrets: async () => [], open: async () => stream(['2026-09-19T00:00:00Z a\n2026-09-19T00:00:01Z b\n']) });
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const text = await res.text();
    expect(text).toContain('id: 2026-09-19T00:00:00Z\nevent: line\ndata: {"ts":"2026-09-19T00:00:00Z","text":"a"}\n\n');
    expect(text).toContain('event: end\ndata: {"reason":"pod-ended"}\n\n');
  });
  it('resumes from Last-Event-ID via sinceTime', async () => {
    const open = vi.fn(async () => stream([]));
    await (await taskLogResponse(request('follow=1', { accept: 'text/event-stream', 'last-event-id': '2026-09-19T00:00:05Z' }), session, 'w1', 'train', { ...base, listPods: async () => [pod(2)], secrets: async () => [], open })).text();
    expect(open.mock.calls[0][2]).toMatchObject({ sinceTime: '2026-09-19T00:00:05Z' });
  });
  it('ends with timeout after the lifetime even if the kubelet stream stays open', async () => {
    const open = async (_ns: string, _pod: string, opts: { signal?: AbortSignal }) => new ReadableStream<Uint8Array>({ start(c) { opts.signal?.addEventListener('abort', () => c.close()); } });
    const res = await taskLogResponse(request('follow=1', { accept: 'text/event-stream' }), session, 'w1', 'train', { ...base, listPods: async () => [pod(2)], secrets: async () => [], open, lifetimeMs: 20 });
    expect(await res.text()).toContain('event: end\ndata: {"reason":"timeout"}');
  });
  it('emits log-error and closes when re-authorization fails', async () => {
    const { authorizeLogs } = await import('./auth');
    (authorizeLogs as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: 'w1', namespace: 'team', projectId: 'p1' }).mockRejectedValueOnce(new Error('revoked'));
    const open = async (_ns: string, _pod: string, opts: { signal?: AbortSignal }) => new ReadableStream<Uint8Array>({ start(c) { opts.signal?.addEventListener('abort', () => c.close()); } });
    const res = await taskLogResponse(request('follow=1', { accept: 'text/event-stream' }), session, 'w1', 'train', { ...base, listPods: async () => [pod(2)], secrets: async () => [], open, authMs: 5, lifetimeMs: 500 });
    expect(await res.text()).toContain('event: log-error');
  });
});
```

- [ ] **Step 3: 실패 확인**

Run: `cd dashboard/web && npm test -- src/server/logs/http.test.ts`
Expected: FAIL — 기존 `readTaskLogs`/커서 구현과 맞지 않음.

- [ ] **Step 4: `http.ts` 구현**

```ts
import type { Session } from '../auth/session';
import { HttpError } from '../errors';
import { getPod, listPods, podLogs, streamPodLogs, type Pod } from '../k8s/resources';
import { getRepo } from '../store/repo';
import type { Task, Workflow } from '../store/types';
import { injectedLogSecrets } from '../workflow-adapters/log-secrets';
import { authorizeLogs } from './auth';
import { SecretRedactor } from './redaction';
import { followLogs, pickContainer, pickTarget, readLogs, resolveTargets } from './stream';
import { LIMITS, type LogDeps, type LogLine, type LogSnapshot, type LogTarget } from './types';

export interface LogHttpDeps extends LogDeps {
  listPods?: typeof listPods; getPod?: typeof getPod; secrets?: typeof injectedLogSecrets;
  read?: typeof podLogs; open?: typeof streamPodLogs; authMs?: number; lifetimeMs?: number;
}
const HEADERS = { 'cache-control': 'no-store, no-transform', 'x-content-type-options': 'nosniff' };
const int = (v: string | null, name: string) => { if (v === null) return undefined; const n = Number(v); if (!Number.isSafeInteger(n) || n < 0) throw new HttpError(400, `${name} must be a non-negative integer`); return n; };
const since = (v: string | null) => { if (!v) return undefined; if (!/^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/.test(v)) throw new HttpError(400, 'since must be an RFC3339 UTC timestamp'); return v; };

/** Redactor from the immutable per-attempt Secret; `undefined` when the binding cannot be verified. */
export async function redactorFor(wf: Workflow, task: Task | undefined, target: LogTarget, container: string, deps: LogHttpDeps): Promise<SecretRedactor | undefined> {
  if (!task) return undefined;
  const pod = await (deps.getPod ?? getPod)(target.namespace, target.podName);
  if (!pod) return undefined;
  try { return new SecretRedactor(await (deps.secrets ?? injectedLogSecrets)(wf, { ...task, attempts: target.attempt }, pod as Pod, container)); }
  catch { return undefined; }
}

export async function taskLogResponse(req: Request, p: Session, workflowId: string, taskName: string, deps: LogHttpDeps = { repo: getRepo() }): Promise<Response> {
  const url = new URL(req.url);
  const wf = await authorizeLogs(p, workflowId, taskName, deps);
  const targets = await resolveTargets(wf, taskName, deps.listPods);
  const tasks = await deps.repo.listTasks(wf.id);
  const task = tasks.find(t => t.name === taskName);
  const want = { attempt: int(url.searchParams.get('attempt'), 'attempt'), member: int(url.searchParams.get('member'), 'member') };
  const target = pickTarget(targets, want);
  if (!target) {
    const snapshot: LogSnapshot = { source: 'none', reason: task?.startedAt || task?.jobName ? 'pod-gone' : 'not-started', targets, lines: [], truncated: false, redaction: 'none' };
    return Response.json(snapshot, { headers: HEADERS });
  }
  const container = pickContainer(target, url.searchParams.get('container') ?? undefined);
  const tail = int(url.searchParams.get('tail'), 'tail');
  const sinceTime = since(req.headers.get('last-event-id') ?? url.searchParams.get('since'));
  const redactor = await redactorFor(wf, task, target, container, deps);
  const redaction = redactor ? 'applied' : 'unavailable';
  const follow = url.searchParams.get('follow') === '1' && (req.headers.get('accept') ?? '').includes('text/event-stream');
  if (!follow) {
    const { lines, truncated } = await readLogs(target, container, { tail, sinceTime, redactor, read: deps.read });
    const snapshot: LogSnapshot = { source: 'kubernetes', phase: target.phase, target, container, targets, lines, truncated, redaction };
    return Response.json(snapshot, { headers: HEADERS });
  }
  const stop = new AbortController();
  const lines = followLogs(target, container, { tail, sinceTime, redactor, signal: stop.signal, open: deps.open });
  return sseResponse(lines, { lifetimeMs: deps.lifetimeMs ?? LIMITS.followMs, authMs: deps.authMs ?? 5000, stop, request: req.signal,
    reauth: async () => { await authorizeLogs(p, workflowId, taskName, deps); } });
}

export function sseResponse(lines: AsyncIterable<LogLine>, opts: { lifetimeMs: number; authMs: number; stop: AbortController; request: AbortSignal; reauth: () => Promise<void> }): Response {
  const enc = new TextEncoder();
  let closed = false, reason: 'pod-ended' | 'timeout' = 'pod-ended', failure: HttpError | Error | undefined;
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const finish = (why?: typeof reason) => { if (closed) return; if (why) reason = why; closed = true; opts.stop.abort(); };
      const deadline = setTimeout(() => finish('timeout'), opts.lifetimeMs);
      const auth = setInterval(() => { opts.reauth().catch(error => { failure = error; finish(); }); }, opts.authMs);
      opts.request.addEventListener('abort', () => finish(), { once: true });
      try {
        for await (const line of lines) {
          if (closed) break;
          controller.enqueue(enc.encode(`${line.ts ? `id: ${line.ts}\n` : ''}event: line\ndata: ${JSON.stringify(line)}\n\n`));
        }
        if (failure) controller.enqueue(enc.encode(`event: log-error\ndata: ${JSON.stringify({ error: 'Log stream stopped; authorization is no longer valid', code: failure instanceof HttpError ? failure.code : 'log_unavailable' })}\n\n`));
        else controller.enqueue(enc.encode(`event: end\ndata: ${JSON.stringify({ reason })}\n\n`));
      } catch (error) {
        if (!opts.stop.signal.aborted) controller.enqueue(enc.encode(`event: log-error\ndata: ${JSON.stringify({ error: 'Log stream failed', code: error instanceof HttpError ? error.code : 'log_unavailable' })}\n\n`));
        else controller.enqueue(enc.encode(`event: end\ndata: ${JSON.stringify({ reason })}\n\n`));
      } finally { clearTimeout(deadline); clearInterval(auth); closed = true; try { controller.close(); } catch { /* already closed */ } }
    },
    cancel() { closed = true; opts.stop.abort(); },
  });
  return new Response(body, { headers: { ...HEADERS, 'content-type': 'text/event-stream', 'x-accel-buffering': 'no' } });
}
```
`route.ts:4` 주석을 `/** Reads the task's current Pod through the Kubernetes API; nothing is stored. Pod deletion ends log availability. */`로.

- [ ] **Step 5: 통과 확인**

Run: `cd dashboard/web && npm test -- src/server/logs/http.test.ts src/server/logs/stream.test.ts`
Expected: PASS. `lifetimeMs: 20` 테스트에서 `followLogs`가 abort 후 스트림 close를 받아야 하므로 `open` mock이 `signal`을 존중하는지 확인한다(위 테스트가 그렇게 작성되어 있다).

- [ ] **Step 6: 커밋**

```bash
git add dashboard/web/src/server/logs/http.ts dashboard/web/src/server/logs/http.test.ts dashboard/web/src/server/logs/auth.ts "dashboard/web/src/app/api/workflows/[id]/tasks/[task]/logs/route.ts"
git commit -m "feat(dashboard): task log endpoint streams kubelet lines with project authorization and secret redaction

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Pod 로그 라우트 단일화, `retained.ts` 삭제

**Files:**
- Rewrite: `dashboard/web/src/app/api/k8s/pods/[ns]/[name]/logs/route.ts`
- Delete: `dashboard/web/src/server/logs/retained.ts`, `retained.test.ts`
- Create: `dashboard/web/src/app/api/k8s/pods/[ns]/[name]/logs/route.test.ts`

**Interfaces:**
- Consumes: Task 1 `targetsFromPods`, `pickContainer`, `readLogs`, `followLogs`; Task 2 `sseResponse`, `redactorFor`; 기존 `assertNamespaceAccess(session, namespace)`(`server/auth/projects.ts:150`).
- 동작: `getPod(ns, name)` → 없으면 `{ source: 'none', reason: 'pod-gone' }`. Pod에 `pai.aws/workflow-id`·`pai.aws/task` 라벨이 있으면 워크플로·태스크를 읽어 redaction 적용, 검증 실패 시 admin은 `redaction: 'unavailable'`로 진행하고 그 외는 403 `log_redaction_unavailable`. 라벨이 없는 Pod(대시보드 외 워크로드)는 `redaction: 'none'`.

- [ ] **Step 1: 실패하는 테스트**

```ts
import { describe, expect, it, vi } from 'vitest';
import type { Pod } from '@/server/k8s/resources';
const mocks = vi.hoisted(() => ({ getPod: vi.fn(), podLogs: vi.fn(async () => '2026-09-19T00:00:00Z k=V4LUE\n'), secrets: vi.fn(async () => ['V4LUE']), access: vi.fn(async () => undefined) }));
vi.mock('@/server/k8s/resources', () => ({ getPod: mocks.getPod, podLogs: mocks.podLogs, streamPodLogs: vi.fn(), listPods: vi.fn() }));
vi.mock('@/server/workflow-adapters/log-secrets', () => ({ injectedLogSecrets: mocks.secrets }));
vi.mock('@/server/auth/projects', () => ({ assertNamespaceAccess: mocks.access }));
vi.mock('@/server/store/repo', () => ({ getRepo: () => ({ getWorkflow: async () => ({ id: 'w1', namespace: 'team' }), listTasks: async () => [{ name: 'train', attempts: 1 }] }) }));
vi.mock('@/server/api', () => ({ route: (_role: string, handler: (ctx: unknown) => Promise<unknown>) => async (req: Request, ctx: { params: Promise<Record<string, string>> }) => {
  try { const r = await handler({ req, params: await ctx.params, session: { user: 'u', subject: 's', role: 'researcher', authMethod: 'alb' } }); return r instanceof Response ? r : Response.json(r); }
  catch (e) { return Response.json({ error: String(e) }, { status: (e as { status?: number }).status ?? 500 }); } } }));
const managed: Pod = { metadata: { name: 'p', namespace: 'team', uid: 'u1', labels: { 'pai.aws/workflow-id': 'w1', 'pai.aws/task': 'train', 'pai.aws/attempt': '1' } }, spec: { containers: [{ name: 'main' }] } as Pod['spec'], status: { phase: 'Running' } };
const call = async (query = '') => { const { GET } = await import('./route'); return GET(new Request(`http://x/api/k8s/pods/team/p/logs?${query}`) as never, { params: Promise.resolve({ ns: 'team', name: 'p' }) }); };

describe('pod logs route', () => {
  it('returns pod-gone for a missing pod after checking namespace access', async () => {
    mocks.getPod.mockResolvedValueOnce(null);
    expect(await (await call()).json()).toMatchObject({ source: 'none', reason: 'pod-gone' });
    expect(mocks.access).toHaveBeenCalledWith(expect.anything(), 'team');
  });
  it('redacts dashboard-managed pods using the attempt secret', async () => {
    mocks.getPod.mockResolvedValue(managed);
    expect(await (await call('tail=10')).json()).toMatchObject({ source: 'kubernetes', redaction: 'applied', lines: [{ text: 'k=[REDACTED]' }] });
  });
  it('refuses non-admin reads when redaction cannot be verified', async () => {
    mocks.getPod.mockResolvedValue(managed); mocks.secrets.mockRejectedValueOnce(new Error('unverified'));
    const res = await call();
    expect(res.status).toBe(403);
  });
  it('serves unmanaged pods without redaction', async () => {
    mocks.getPod.mockResolvedValue({ ...managed, metadata: { name: 'p', namespace: 'team', uid: 'u2', labels: {} } });
    expect(await (await call()).json()).toMatchObject({ redaction: 'none', lines: [{ text: 'k=V4LUE' }] });
  });
});
```
`route()` mock은 실제 `route()`처럼 params를 await하고 `HttpError`를 상태 코드로 변환한다. 라우트는 항상 `Response.json(...)`을 돌려준다.

- [ ] **Step 2: 실패 확인**

Run: `cd dashboard/web && npm test -- "src/app/api/k8s/pods/\[ns\]/\[name\]/logs/route.test.ts"`
Expected: FAIL — 아카이브 기반 구현.

- [ ] **Step 3: 라우트 구현**

```ts
import { route } from '@/server/api';
import { HttpError } from '@/server/errors';
import { assertNamespaceAccess } from '@/server/auth/projects';
import { getPod } from '@/server/k8s/resources';
import { getRepo } from '@/server/store/repo';
import { redactorFor, sseResponse } from '@/server/logs/http';
import { followLogs, pickContainer, readLogs, targetsFromPods } from '@/server/logs/stream';
import { LIMITS, type LogSnapshot } from '@/server/logs/types';
export const dynamic = 'force-dynamic';
const HEADERS = { 'cache-control': 'no-store, no-transform', 'x-content-type-options': 'nosniff' };
export const GET = route<{ ns: string; name: string }>('viewer', async ({ params, req, session }) => {
  await assertNamespaceAccess(session, params.ns);
  if (![params.ns, params.name].every(v => /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/.test(v))) throw new HttpError(400, 'Invalid Pod identity');
  const url = new URL(req.url), pod = await getPod(params.ns, params.name);
  if (!pod) return Response.json({ source: 'none', reason: 'pod-gone', targets: [], lines: [], truncated: false, redaction: 'none' } satisfies LogSnapshot, { headers: HEADERS });
  const labels = pod.metadata.labels ?? {};
  const target = targetsFromPods([{ ...pod, metadata: { ...pod.metadata, labels: { 'pai.aws/attempt': '0', ...labels } } }])[0];
  const container = pickContainer(target, url.searchParams.get('container') ?? undefined);
  const tailRaw = url.searchParams.get('tail'), tail = tailRaw === null ? undefined : Number(tailRaw);
  const sinceTime = req.headers.get('last-event-id') ?? url.searchParams.get('since') ?? undefined;
  let redaction: LogSnapshot['redaction'] = 'none', redactor;
  if (labels['pai.aws/workflow-id'] && labels['pai.aws/task']) {
    const repo = getRepo(), wf = await repo.getWorkflow(labels['pai.aws/workflow-id']);
    const task = wf ? (await repo.listTasks(wf.id)).find(t => t.name === labels['pai.aws/task']) : undefined;
    redactor = wf ? await redactorFor(wf, task, target, container, { repo }) : undefined;
    redaction = redactor ? 'applied' : 'unavailable';
    if (!redactor && session.role !== 'admin') throw new HttpError(403, 'Secret redaction for this Pod cannot be verified; ask an administrator', 'log_redaction_unavailable');
  }
  if (url.searchParams.get('follow') === '1' && (req.headers.get('accept') ?? '').includes('text/event-stream')) {
    const stop = new AbortController();
    return sseResponse(followLogs(target, container, { tail, sinceTime, redactor, signal: stop.signal }),
      { lifetimeMs: LIMITS.followMs, authMs: 5000, stop, request: req.signal, reauth: () => assertNamespaceAccess(session, params.ns) });
  }
  const { lines, truncated } = await readLogs(target, container, { tail, sinceTime, redactor });
  return Response.json({ source: 'kubernetes', phase: pod.status?.phase, target, container, targets: [target], lines, truncated, redaction } satisfies LogSnapshot, { headers: HEADERS });
});
```

- [ ] **Step 4: `retained.ts`·`retained.test.ts` 삭제, 통과 확인**

Run: `cd dashboard/web && git rm -q src/server/logs/retained.ts src/server/logs/retained.test.ts && npm test -- src/app/api/k8s && npm run typecheck`
Expected: PASS. typecheck는 아직 archive 참조가 남아 실패할 수 있다(Task 4에서 정리). 이 단계에서는 라우트 테스트 통과만 확인한다.

- [ ] **Step 5: 커밋**

```bash
git add -A dashboard/web/src/app/api/k8s/pods dashboard/web/src/server/logs
git commit -m "feat(dashboard): pod log route reads the kubelet directly with redaction for managed pods

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: 아카이브·수집기·env 제거, controller 배선 정리

**Files:**
- Delete: `dashboard/web/src/server/logs/{archive,archive.test,collector,collector.test,capture,capture.test,cursors,kubernetes,kubernetes.test}.ts`
- Delete: `dashboard/web/src/server/workflow-adapters/logs.ts`, `logs.test.ts`
- Modify: `dashboard/web/src/server/logs/index.ts`
- Modify: `dashboard/web/src/server/workflow-adapters/dependencies.ts:10,16`, `dependencies.test.ts:13`
- Modify: `dashboard/web/src/server/workflow/controller.ts:52`
- Modify: `dashboard/web/src/server/workflow/ports.ts:135-138`
- Modify: `dashboard/web/src/server/workflow/execution.ts:234,468,470`
- Modify: `dashboard/web/src/server/config.ts:76`
- Modify: `dashboard/web/scripts/dev-local.sh:96`
- Modify: `dashboard/infra/lib/dashboard-stack.ts:116`

- [ ] **Step 1: 파일 삭제**

```bash
cd dashboard/web && git rm -q src/server/logs/archive.ts src/server/logs/archive.test.ts src/server/logs/collector.ts src/server/logs/collector.test.ts \
  src/server/logs/capture.ts src/server/logs/capture.test.ts src/server/logs/cursors.ts src/server/logs/kubernetes.ts src/server/logs/kubernetes.test.ts \
  src/server/workflow-adapters/logs.ts src/server/workflow-adapters/logs.test.ts
```

- [ ] **Step 2: 배선 수정**

`logs/index.ts`:
```ts
export { taskLogResponse, sseResponse, redactorFor } from './http';
export { resolveTargets, readLogs, followLogs } from './stream';
export type { LogTarget, LogLine, LogSnapshot } from './types';
```
`dependencies.ts`: 10행 import와 16행 `...(process.env.LOG_ARCHIVE_ENABLED === '1' ? { logs: … } : {}),` 삭제. `dependencies.test.ts:13`의 `vi.mock('./logs', …)` 삭제.
`controller.ts:52`: `k8s: { ...realK8s, ensureAttemptSecret },`.
`ports.ts:135-138`: `logs?: {...}` 블록 삭제.
`execution.ts`: 234행 `await deps.logs?.drain(...)`, 468행·470행 `await deps.logs?.reconcile(...)` 삭제(470행 삭제 후 `return result;`만 남는다).
`config.ts:76`: `'LOG_ARCHIVE_ENABLED',` 삭제.
`dev-local.sh:96`: `export LOG_ARCHIVE_ENABLED=0` 줄 삭제.
`dashboard-stack.ts:116`: `LOG_ARCHIVE_ENABLED: '1',` 삭제.

- [ ] **Step 3: 잔재 검색과 전체 테스트**

Run: `cd dashboard/web && grep -rn "LOG_ARCHIVE_ENABLED\|logs/archive\|logs/collector\|logs/capture\|logs/cursors\|LogArchive\|workflowLogHooks\|LOG_POD#\|LOG_DRAIN#\|LOG_CURSOR#" src ../infra/lib ../infra/test scripts; npm run typecheck && npm test`
Expected: grep 출력 없음(테스트 fixture의 문자열 제외), typecheck 통과. `reliability.test.ts:98`은 `deps.k8s.ensureAttemptSecret = secrets;`로 이미 명시 주입하므로 그대로 통과해야 한다. 실패하는 테스트가 `LogViewer`/`log-replay` 브라우저·클라이언트 테스트라면 Task 5에서 처리하므로 여기서는 서버 테스트만 통과하면 된다(`npm test -- src/server`).

- [ ] **Step 4: 인프라 테스트**

Run: `cd dashboard/infra && npx tsc --noEmit -p . && node --require ts-node/register --test test/*.test.ts`
Expected: PASS. env 스냅샷을 검사하는 테스트가 `LOG_ARCHIVE_ENABLED`를 기대하면 그 기대를 제거한다.

- [ ] **Step 5: 커밋**

```bash
git add -A dashboard/web/src dashboard/web/scripts dashboard/infra/lib dashboard/infra/test
git commit -m "refactor(dashboard): remove the DynamoDB log archive, collector and LOG_ARCHIVE_ENABLED; always create attempt secrets

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: `LogViewer` 재작성, JobsPage 정리, i18n

**Files:**
- Rewrite: `dashboard/web/src/components/workflows/LogViewer.tsx`
- Delete: `dashboard/web/src/components/workflows/log-replay.ts`, `log-replay.test.ts`
- Rewrite: `dashboard/web/src/components/workflows/LogViewer.browser.test.ts`
- Modify: `dashboard/web/src/components/pages/JobsPage.tsx:343-346,369-372`
- Rewrite: `dashboard/web/src/lib/i18n/messages/logs.ts`
- Modify: `dashboard/web/src/lib/i18n/messages/jobs.ts:18,34`

**Interfaces:**
- Consumes: `LogSnapshot`, `LogLine`, `LogTarget` (`@/server/logs/types`); API `GET …/logs?attempt&member&container&tail&since&follow=1`; SSE 이벤트 `line`/`end`/`log-error`.

- [ ] **Step 1: i18n 교체** — `logs.ts`

```ts
import { defineMessages } from '../define';
export const logs = defineMessages({
  en: {
    task: 'Task', target: 'Pod', targetLatest: 'Latest attempt · first member',
    attempt: 'Attempt', member: 'Member', container: 'Container',
    follow: 'Follow', live: 'Live', ended: 'Ended', podGone: 'Pod removed', notStarted: 'Not started',
    filterLabel: 'Filter logs', filterPlaceholder: 'Search logs…', reopen: 'Reopen', downloadShown: 'Download shown logs',
    logRegion: 'Task log', noLogsYet: 'No log lines yet.',
    podGoneInfo: 'Logs are read from the Pod through the Kubernetes API and are available only while the Pod exists. Nothing is stored by the dashboard.',
    redactionUnavailable: 'Secret redaction could not be verified for this Pod; values injected as credentials may appear in plain text.',
    limitInfo: 'Shows up to 5,000 lines per request; the view keeps the last 10,000 lines.',
    truncatedWarning: 'Earlier lines were trimmed from the view.',
    connectionLost: 'Connection lost. Reconnecting from the last timestamp…',
    permissionExpired: 'Log permission expired. Reopen the log.', loadFailed: 'Log lookup failed',
  },
  ko: {
    task: '작업', target: 'Pod', targetLatest: '최근 시도 · 첫 번째 멤버',
    attempt: '시도', member: '멤버', container: '컨테이너',
    follow: '계속 보기', live: '실시간', ended: '종료', podGone: 'Pod 삭제됨', notStarted: '시작 전',
    filterLabel: '로그 필터', filterPlaceholder: '로그 검색…', reopen: '다시 열기', downloadShown: '표시 로그 다운로드',
    logRegion: '작업 로그', noLogsYet: '아직 로그 줄이 없습니다.',
    podGoneInfo: '로그는 Kubernetes API로 Pod에서 직접 읽으며 Pod가 있는 동안만 볼 수 있습니다. 대시보드는 로그를 저장하지 않습니다.',
    redactionUnavailable: '이 Pod의 비밀값 필터를 검증할 수 없어 자격증명으로 주입된 값이 그대로 보일 수 있습니다.',
    limitInfo: '요청당 최대 5,000줄을 읽고 화면은 최근 10,000줄을 유지합니다.',
    truncatedWarning: '이전 화면 내용이 잘렸습니다.',
    connectionLost: '연결이 끊어졌습니다. 마지막 시각부터 다시 연결합니다.',
    permissionExpired: '로그 권한이 만료되었습니다. 다시 열어 주세요.', loadFailed: '로그 조회 실패',
  },
});
```
`jobs.ts`의 `retainedLogsLabel` 두 줄 삭제.

- [ ] **Step 2: `LogViewer.tsx` 재작성**

```tsx
'use client';
import { useEffect, useRef, useState } from 'react';
import { Badge, Button, ErrorBox, Input, Select, Spinner, Toggle } from '@/components/ui';
import { api, ApiError } from '@/lib/api-client';
import { useT } from '@/lib/i18n';
import type { Task } from '@/server/store/types';
import type { LogLine, LogSnapshot, LogTarget } from '@/server/logs/types';

const MAX_LINES = 10_000;
interface LogViewerProps { workflowId: string; tasks: Task[]; selectedTask?: string }
const key = (t: LogTarget) => `${t.attempt}/${t.member}`;
export function LogViewer({ workflowId, tasks, selectedTask }: LogViewerProps) {
  const t = useT('logs');
  const [task, setTask] = useState(selectedTask || tasks[0]?.name || '');
  const [targetKey, setTargetKey] = useState('');
  const [container, setContainer] = useState('');
  const [follow, setFollow] = useState(() => tasks.some(x => x.name === task && x.phase === 'RUNNING'));
  const [snapshot, setSnapshot] = useState<LogSnapshot>();
  const [lines, setLines] = useState<LogLine[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [filter, setFilter] = useState('');
  const [reload, setReload] = useState(0);
  const scroll = useRef<HTMLDivElement>(null), userScrolled = useRef(false), lastTs = useRef('');
  useEffect(() => { if (selectedTask) setTask(selectedTask); }, [selectedTask]);
  useEffect(() => { if (!tasks.some(x => x.name === task)) setTask(tasks[0]?.name ?? ''); }, [tasks, task]);
  useEffect(() => {
    const abort = new AbortController();
    let stopped = false, timer: ReturnType<typeof setTimeout> | undefined, source: EventSource | undefined;
    setLines([]); setTruncated(false); setSnapshot(undefined); setError(null); setLoading(!!task); lastTs.current = ''; userScrolled.current = false;
    const base = `/api/workflows/${encodeURIComponent(workflowId)}/tasks/${encodeURIComponent(task)}/logs`;
    const [attempt, member] = targetKey.split('/');
    const query = (extra: Record<string, string> = {}) => new URLSearchParams({ ...(attempt ? { attempt, member } : {}), ...(container ? { container } : {}), ...extra });
    const append = (next: LogLine[]) => setLines(prev => {
      const seen = new Set(prev.slice(-64).map(l => `${l.ts}|${l.text}`));
      const merged = [...prev, ...next.filter(l => !l.ts || !seen.has(`${l.ts}|${l.text}`))];
      if (merged.length > MAX_LINES) { setTruncated(true); return merged.slice(-MAX_LINES); }
      return merged;
    });
    const connect = () => {
      source = new EventSource(`${base}?${query({ follow: '1', ...(lastTs.current ? { since: lastTs.current } : {}) })}`);
      const own = source;
      own.addEventListener('line', event => { if (stopped) return; const line = JSON.parse((event as MessageEvent).data) as LogLine; if (line.ts) lastTs.current = line.ts; append([line]); });
      own.addEventListener('end', event => { own.close(); if (stopped) return; const { reason } = JSON.parse((event as MessageEvent).data) as { reason: string }; if (reason === 'timeout' && follow) connect(); else setFollow(false); });
      own.addEventListener('log-error', () => { own.close(); setError(new Error(t('permissionExpired'))); });
      own.onerror = () => { own.close(); if (!stopped) { setError(new Error(t('connectionLost'))); timer = setTimeout(connect, 2000); } };
    };
    async function read() {
      try {
        const page = await api<LogSnapshot>(`${base}?${query({ tail: '1000' })}`, { signal: abort.signal });
        if (stopped) return;
        setSnapshot(page); setLines(page.lines); setTruncated(page.truncated); lastTs.current = page.lines.at(-1)?.ts ?? '';
        if (follow && page.source === 'kubernetes' && page.phase === 'Running') connect();
        else if (follow && page.source === 'none' && page.reason === 'not-started') timer = setTimeout(read, 3000);
      } catch (e) {
        if (stopped) return;
        setError(e instanceof Error ? e : new Error(t('loadFailed')));
        if (!(e instanceof ApiError) || e.status >= 500) timer = setTimeout(read, 3000);
      } finally { if (!stopped) setLoading(false); }
    }
    if (task) void read();
    return () => { stopped = true; abort.abort(); clearTimeout(timer); source?.close(); };
  }, [workflowId, task, targetKey, container, follow, reload, t]);
  useEffect(() => { if (follow && !userScrolled.current) scroll.current?.scrollTo(0, scroll.current.scrollHeight); }, [lines, follow]);
  const targets = snapshot?.targets ?? [];
  const status = snapshot?.source === 'none' ? (snapshot.reason === 'pod-gone' ? t('podGone') : t('notStarted')) : snapshot?.phase === 'Running' ? t('live') : snapshot ? t('ended') : '';
  const text = lines.map(l => l.text).join('\n');
  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const link = document.createElement('a'); link.href = url; link.download = `${task}-displayed-logs.txt`; link.click(); URL.revokeObjectURL(url);
  };
  return <div className="space-y-3">
    <div className="flex gap-3 items-end flex-wrap">
      <label className="flex-1 min-w-40 text-xs">{t('task')}<Select value={task} onChange={e => setTask(e.target.value)}>
        {tasks.map(item => <option key={item.name} value={item.name}>{item.name}</option>)}
      </Select></label>
      <label className="flex-1 min-w-40 text-xs">{t('target')}<Select value={targetKey} onChange={e => setTargetKey(e.target.value)}>
        <option value="">{t('targetLatest')}</option>
        {targets.map(x => <option key={key(x)} value={key(x)}>{t('attempt')} {x.attempt} · {t('member')} {x.member} · {x.podName} · {x.phase ?? ''}</option>)}
      </Select></label>
      <label className="text-xs">{t('container')}<Select value={container} onChange={e => setContainer(e.target.value)}>
        <option value="">main</option>
        {(snapshot?.target?.containers ?? []).filter(c => c !== 'main').map(c => <option key={c} value={c}>{c}</option>)}
      </Select></label>
      <Toggle checked={follow} onChange={setFollow} label={t('follow')} />
      {status && <Badge tone={snapshot?.source === 'none' ? 'warning' : 'info'}>{status}</Badge>}
    </div>
    {error && <ErrorBox error={error} />}
    {snapshot?.source === 'none' && <p role="status" className="text-xs text-fg-muted">{t('podGoneInfo')}</p>}
    {snapshot?.redaction === 'unavailable' && <p role="alert" className="text-xs text-warning">{t('redactionUnavailable')}</p>}
    <div className="flex gap-2"><Input aria-label={t('filterLabel')} placeholder={t('filterPlaceholder')} value={filter} onChange={e => setFilter(e.target.value)} className="flex-1" />
      <Button size="sm" variant="ghost" onClick={() => setReload(n => n + 1)}>{t('reopen')}</Button>
      <Button size="sm" variant="ghost" onClick={download} disabled={!text}>{t('downloadShown')}</Button>
    </div>
    <div ref={scroll} onScroll={e => { const el = e.currentTarget; userScrolled.current = el.scrollTop < el.scrollHeight - el.clientHeight - 10; }} aria-label={t('logRegion')} className="log-view bg-black/30 rounded border border-gray-700 p-3 h-96 overflow-auto scrollbar-thin space-y-0">
      {loading && <Spinner />}
      {!loading && !lines.length && <p className="text-xs text-fg-muted">{t('noLogsYet')}</p>}
      {lines.map((line, i) => !filter || line.text.toLowerCase().includes(filter.toLowerCase()) ? <div key={i} style={{ whiteSpace: 'pre-wrap' }}><span className="ln">{i + 1}</span>{line.text}</div> : null)}
    </div>
    <p className="text-xs text-fg-muted">{t('limitInfo')}{truncated ? ` ${t('truncatedWarning')}` : ''}</p>
  </div>;
}
```
`Badge`의 `tone` 유니온에 `'warning'`이 없으면 `'info'`만 쓴다(`components/ui`를 확인).

- [ ] **Step 3: JobsPage 수정**

343~344행: `const [retained, setRetained] = …` 삭제, URL을 `` `/api/k8s/pods/${job.namespace}/${pod.name}/logs?tail=1000` ``로(follow 파라미터 제거; JSON 폴링은 `refetch: follow ? 2000 : 0`).
346행 타입을 `useApi<{ source: string; phase?: string; lines: { ts: string; text: string }[] }>`로, `filteredLines`는 `logsData.lines.map(l => l.text)` 기준으로 필터.
369~372행 관리자 체크박스 블록 삭제. `useMe` import가 다른 곳에서 안 쓰이면 함께 삭제.

- [ ] **Step 4: 브라우저 테스트 재작성** — `LogViewer.browser.test.ts`

기존 파일의 `beforeAll` 번들·서버 골격은 그대로 두고 fixture와 케이스를 교체한다:
```ts
  const target = { namespace: 'team', podName: 'pod', podUid: 'u1', attempt: 1, member: 0, containers: ['main'], phase: 'Running' };
  const snap = (lines: { ts: string; text: string }[]) => ({ source: 'kubernetes', phase: 'Running', target, container: 'main', targets: [target], lines, truncated: false, redaction: 'applied' });
  // server handler:
      if (url.searchParams.get('follow') === '1') {
        res.setHeader('content-type', 'text/event-stream');
        const since = url.searchParams.get('since');
        if (!since) res.end(`id: 2026-09-19T00:00:02Z\nevent: line\ndata: ${JSON.stringify({ ts: '2026-09-19T00:00:02Z', text: 'live' })}\n\nevent: end\ndata: {"reason":"timeout"}\n\n`);
        else res.end(`id: 2026-09-19T00:00:03Z\nevent: line\ndata: ${JSON.stringify({ ts: '2026-09-19T00:00:03Z', text: 'after reconnect' })}\n\nevent: end\ndata: {"reason":"pod-ended"}\n\n`);
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(snap([{ ts: '2026-09-19T00:00:00Z', text: 'repeat' }, { ts: '2026-09-19T00:00:01Z', text: 'repeat' }, { ts: '', text: '' }, { ts: '2026-09-19T00:00:01Z', text: 'https://example.test' }])));
  // test:
  it('follows via SSE, reconnects with since=<last id> after a timeout end, and keeps earlier lines', async () => {
    …goto, waitFor 'https://example.test'
    await tab.getByRole('button', { name: '계속 보기' }).click();
    await tab.getByText('after reconnect', { exact: false }).waitFor({ timeout: 8000 });
    const content = …(same evaluate as before);
    expect(content?.match(/repeat/g)).toHaveLength(2);
    expect(content).toContain('live');
    expect(requests.some(r => r.searchParams.get('since') === '2026-09-19T00:00:02Z' && r.searchParams.get('follow') === '1')).toBe(true);
    expect(errors).toEqual([]);
  });
```
`tasks` fixture는 `{name:'train',attempts:1,phase:'RUNNING'}` 유지.

- [ ] **Step 5: 테스트**

Run: `cd dashboard/web && git rm -q src/components/workflows/log-replay.ts src/components/workflows/log-replay.test.ts && npm run typecheck && npm test -- src/components src/lib`
Expected: PASS (브라우저 테스트는 Chromium이 없으면 skip). `no-hardcoded-strings.test.ts` 통과.

- [ ] **Step 6: 커밋**

```bash
git add -A dashboard/web/src/components dashboard/web/src/lib/i18n
git commit -m "feat(dashboard): log viewer streams kubelet lines and explains pod-gone; drop replay protocol and retained toggle

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: CLI `workflows logs` 재작성

**Files:**
- Modify: `dashboard/cli/pai.py:172-282` (`LogCursorFile`·`replay_logs` 삭제 → `stream_logs`), `:520-523` (파서), `:586` (dispatch)
- Delete: `dashboard/cli/tests/test_log_replay.py`
- Create: `dashboard/cli/tests/test_log_stream.py`
- Modify: `dashboard/cli/README.md:46-48`

**Interfaces:**
- 명령: `pai workflows logs RUN --task T [--attempt N] [--member M] [--container C] [--tail N] [--follow]`.
- `ApiClient.open_stream(path, headers)`: `transport.open('GET', origin + '/api/v1' + path, headers)`를 반환(SSE용, 상태 검사 포함).

- [ ] **Step 1: 실패하는 테스트** — `test_log_stream.py`

```python
import io, sys, tempfile, unittest
from pathlib import Path
from unittest.mock import patch
from contextlib import redirect_stdout, redirect_stderr
sys.path.insert(0, str(Path(__file__).parent))
from test_pai import pai, TOKEN, Response, FakeTransport

def snapshot(lines, source='kubernetes', phase='Running'):
    return {'source': source, 'phase': phase, 'redaction': 'applied', 'truncated': False, 'targets': [], 'lines': [{'ts': ts, 'text': text} for ts, text in lines]}
def sse(events):
    return ''.join(f"id: {i}\nevent: {e}\ndata: {d}\n\n" if i else f"event: {e}\ndata: {d}\n\n" for i, e, d in events).encode()

class LogStreamTests(unittest.TestCase):
    def run_logs(self, responses, extra=None):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'private' / 'credentials.json'
            pai.ConfigStore(path).save('https://dashboard.test', TOKEN, 'project-a')
            output, errors = io.StringIO(), io.StringIO()
            transport = FakeTransport(responses)
            with patch.object(pai, 'HttpTransport', return_value=transport), redirect_stdout(output), redirect_stderr(errors):
                code = pai.main(['--config', str(path), 'workflows', 'logs', 'run', '--task', 'train'] + (extra or []))
            return code, output.getvalue(), errors.getvalue(), transport.requests

    def test_snapshot_prints_text_and_passes_selectors(self):
        code, out, _, requests = self.run_logs([Response(200, snapshot([('t1', 'same'), ('t2', 'same'), ('t3', ''), ('t4', 'https://example.test')]))], ['--attempt', '2', '--member', '1', '--container', 'main', '--tail', '50'])
        self.assertEqual(code, 0)
        self.assertEqual(out, 'same\nsame\n\nhttps://example.test\n')
        self.assertIn('attempt=2&member=1&container=main&tail=50', requests[0][1])

    def test_pod_gone_reports_on_stderr(self):
        code, out, err, _ = self.run_logs([Response(200, {'source': 'none', 'reason': 'pod-gone', 'targets': [], 'lines': [], 'truncated': False, 'redaction': 'none'})])
        self.assertEqual((code, out), (0, ''))
        self.assertIn('Pod', err)

    def test_follow_streams_sse_and_reconnects_with_since_after_timeout(self):
        first = sse([('2026-09-19T00:00:01Z', 'line', '{"ts":"2026-09-19T00:00:01Z","text":"a"}'), ('', 'end', '{"reason":"timeout"}')])
        second = sse([('2026-09-19T00:00:02Z', 'line', '{"ts":"2026-09-19T00:00:02Z","text":"b"}'), ('', 'end', '{"reason":"pod-ended"}')])
        code, out, _, requests = self.run_logs([Response(200, first, {'Content-Type': 'text/event-stream'}), Response(200, second, {'Content-Type': 'text/event-stream'})], ['--follow'])
        self.assertEqual(code, 0)
        self.assertEqual(out, 'a\nb\n')
        self.assertIn('follow=1', requests[0][1]); self.assertNotIn('since=', requests[0][1])
        self.assertIn('since=2026-09-19T00%3A00%3A02Z', requests[1][1])
        self.assertEqual(requests[0][2]['Accept'], 'text/event-stream')

    def test_follow_redacts_the_cli_token_and_stops_on_log_error(self):
        body = sse([('', 'line', '{"ts":"","text":"token ' + TOKEN + '"}'), ('', 'log-error', '{"error":"x","code":"log_forbidden"}')])
        code, out, err, _ = self.run_logs([Response(200, body, {'Content-Type': 'text/event-stream'})], ['--follow'])
        self.assertEqual(out, 'token [REDACTED]\n')
        self.assertNotEqual(code, 0)
        self.assertIn('authorization', err.lower())
```

- [ ] **Step 2: 실패 확인**

Run: `cd dashboard/cli && python3 -m unittest tests.test_log_stream -v`
Expected: FAIL — 옵션 `--tail` 없음 / 아카이브 응답 기대.

- [ ] **Step 3: 구현**

`ApiClient`에 추가:
```python
    def open_stream(self, path, headers=None):
        request_headers = {'Authorization': 'Bearer ' + self._token, 'Accept': 'text/event-stream'}
        if headers: request_headers.update(headers)
        response = self.transport.open('GET', self.origin + '/api/v1' + path, request_headers)
        status_ok(response)
        return response
```
`LogCursorFile`·`replay_logs`를 삭제하고 다음으로 교체:
```python
def _redacting_writer(secret):
    pending = b''
    def write(data, final=False):
        nonlocal pending
        data = pending + data; end = len(data) if final else max(0, len(data) - len(secret) + 1)
        result = bytearray(); pos = 0
        while pos < end:
            at = data.find(secret, pos)
            if at < 0 or at >= end: result.extend(data[pos:end]); pos = end; break
            result.extend(data[pos:at]); result.extend(b'[REDACTED]'); pos = at + len(secret)
        pending = data[pos:]
        if hasattr(sys.stdout, 'buffer'): sys.stdout.buffer.write(result); sys.stdout.buffer.flush()
        else: sys.stdout.write(result.decode('utf-8', 'replace')); sys.stdout.flush()
    return write

def stream_logs(api, path, args):
    if not ID_RE.fullmatch(args.task): raise CliError('Invalid task.')
    if args.attempt is not None and args.attempt < 1 or args.member is not None and not 0 <= args.member < 64: raise CliError('Invalid log attempt/member.')
    if args.container and not ID_RE.fullmatch(args.container): raise CliError('Invalid container.')
    if not 1 <= args.tail <= 5000: raise CliError('--tail must be 1–5000.')
    query = {}
    for key in ('attempt', 'member', 'container'):
        if getattr(args, key) is not None: query[key] = getattr(args, key)
    query['tail'] = args.tail
    base = path + '/tasks/' + args.task + '/logs?'
    write = _redacting_writer(api._token.encode())
    if not args.follow:
        page = require_object(api.json('GET', base + urllib.parse.urlencode(query)))
        if page.get('source') == 'none':
            print('No Pod for this task is available in Kubernetes (%s); logs are not stored by the dashboard.' % page.get('reason', 'unknown'), file=sys.stderr)
            return
        lines = page.get('lines')
        if not isinstance(lines, list) or any(not isinstance(l, dict) or not isinstance(l.get('text'), str) for l in lines): raise CliError('Invalid log response.')
        write(''.join(l['text'] + '\n' for l in lines).encode(), final=True)
        return
    since = None
    while True:
        request_query = dict(query, follow=1)
        if since: request_query['since'] = since
        try: response = api.open_stream(base + urllib.parse.urlencode(request_query))
        except CliError as error:
            transient = str(error).startswith('HTTPS connection failed.') or bool(re.fullmatch(r'Request failed \(HTTP 5[0-9]{2}\)\.', str(error)))
            if not transient: raise
            print('Log connection interrupted; retrying.', file=sys.stderr); time.sleep(2); continue
        if not (response.headers.get('Content-Type') or '').startswith('text/event-stream'):
            page = require_object(read_json(response))
            if page.get('source') == 'none':
                if page.get('reason') == 'not-started': time.sleep(3); continue
                print('No Pod for this task is available in Kubernetes; logs are not stored by the dashboard.', file=sys.stderr); write(b'', final=True); return
            raise CliError('Server did not open a log stream.')
        event, data, ident, ended = None, [], None, None
        with response:
            for raw in response:
                line = raw.decode('utf-8', 'replace').rstrip('\r\n')
                if line == '':
                    if event == 'line':
                        payload = require_object(json.loads('\n'.join(data) or '{}'))
                        if not isinstance(payload.get('text'), str): raise CliError('Invalid log event.')
                        write((payload['text'] + '\n').encode())
                        if ident: since = ident
                    elif event == 'end': ended = require_object(json.loads('\n'.join(data) or '{}')).get('reason'); break
                    elif event == 'log-error':
                        write(b'', final=True); raise CliError('Log stream stopped: authorization is no longer valid.')
                    event, data, ident = None, [], None
                elif line.startswith('event:'): event = line[6:].strip()
                elif line.startswith('data:'): data.append(line[5:].lstrip())
                elif line.startswith('id:'): ident = line[3:].strip()
        if ended == 'pod-ended': break
        if ended is None: print('Log connection interrupted; retrying.', file=sys.stderr); time.sleep(2)
    write(b'', final=True)
```
파서(520~523행) 교체:
```python
    logs = workflows.add_parser('logs'); logs.add_argument('id'); logs.add_argument('--task', required=True); logs.add_argument('--follow', action='store_true', help='Stream new lines while the Pod runs')
    logs.add_argument('--attempt', type=int); logs.add_argument('--member', type=int); logs.add_argument('--container'); logs.add_argument('--tail', type=int, default=1000, help='Lines to read first (1–5000)')
```
586행 `replay_logs(api, path, args)` → `stream_logs(api, path, args)`. `OPAQUE_RE`, `base64`, `codecs`, `secrets`, `stat` import 중 다른 곳에서 안 쓰는 것은 삭제(`grep -n` 확인).

- [ ] **Step 4: 테스트**

Run: `cd dashboard/cli && git rm -q tests/test_log_replay.py && python3 -m unittest discover -s tests -v`
Expected: 모두 PASS. `test_pai.py`에 `logs` 관련 케이스가 있으면 새 옵션으로 갱신.

- [ ] **Step 5: README 46~48행 교체**

```
The CLI does not print request/launch URLs or credentials. `workflows logs` reads the task's current Pod through the dashboard (Kubernetes API); the dashboard stores no log bytes, so logs are available only while the Pod exists. Injected task secrets are redacted server-side from the immutable per-attempt Secret; the CLI additionally redacts its own API token across chunk boundaries.

`--tail N` (default 1000, max 5000) reads recent lines; `--follow` streams new lines over SSE and reconnects from the last timestamp when the 55-second connection window ends. Select `--attempt`, `--member` and `--container` for JobSet members or sidecars. When the Pod is gone the command prints a notice on stderr and exits 0 with no output.
```

- [ ] **Step 6: 커밋**

```bash
git add -A dashboard/cli
git commit -m "feat(cli): workflows logs streams kubelet lines over SSE; remove archive cursor replay

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: e2e 스펙 교체와 문서

**Files:**
- Delete: `dashboard/web/e2e/log-archive.spec.ts`
- Create: `dashboard/web/e2e/log-stream.spec.ts`
- Modify: `dashboard/web/e2e/isaaclab.spec.ts:389-392`
- Modify: `dashboard/README.md:54,87`
- Modify: `dashboard/docs/dashboard-features-and-aws-architecture.md:53,158,343,522,536`
- Modify: `dashboard/docs/diagrams/gen_diagrams.py:622` (+ 02 페이지 `logs` box 문구)

- [ ] **Step 1: `log-stream.spec.ts`**

기존 `log-archive.spec.ts`의 워크플로 fixture(credential 생성, `logger` 태스크 YAML, `researcher.submit`, `researcher.running`)를 그대로 가져오고 관측·단언을 교체:
```ts
    const path = `/api/workflows/${run.id}/tasks/${workflow.task}/logs?follow=1&container=main`;
    type Observed = { opens: number; lines: { ts: string; text: string }[] };
    const observed = await researcher.page.evaluate((url): Promise<Observed> => new Promise((resolve, reject) => {
      const lines: { ts: string; text: string }[] = []; let opens = 0, since = '';
      const timer = setTimeout(() => reject(new Error('log stream deadline')), 190_000);
      const open = () => {
        const source = new EventSource(since ? `${url}&since=${encodeURIComponent(since)}` : url);
        source.onopen = () => { opens++; };
        source.addEventListener('line', event => { const line = JSON.parse((event as MessageEvent).data); lines.push(line); if (line.ts) since = line.ts;
          if (line.text.includes('AFTER_RECONNECT_')) { clearTimeout(timer); source.close(); resolve({ opens, lines }); } });
        source.addEventListener('end', event => { source.close(); if (JSON.parse((event as MessageEvent).data).reason === 'timeout') open(); });
        source.addEventListener('log-error', () => { clearTimeout(timer); source.close(); reject(new Error('log authorization failed')); });
      };
      open();
    }), path);
    const text = observed.lines.map(l => l.text).join('\n');
    expect(observed.opens).toBeGreaterThanOrEqual(2);
    expect(text.split(`repeat-${researcher.tag}`).length - 1).toBe(2);
    expect(text).toContain('https://example.test/metric');
    expect(text).toContain('[REDACTED]');
    expect(text).not.toContain(secret);
    expect(text).toContain('TOKEN_NOT_IN_CHILD_ENV');
    await researcher.completed(run.id);
    // 기존 스펙의 kubectl Job 삭제 + 'owned log Pod removal' poll 블록을 그대로 유지한 뒤:
    const after = await researcher.api<{ source: string; reason?: string }>('GET', `/api/workflows/${run.id}/tasks/${workflow.task}/logs?tail=10`, undefined, [200]);
    expect(after).toMatchObject({ source: 'none', reason: 'pod-gone' });
```
테스트 이름: `'task logs stream from the kubelet with redaction, reconnect by timestamp, and report pod-gone after deletion'`.

- [ ] **Step 2: `isaaclab.spec.ts:389-392`**

`researcher.api<{ source: string; lines: { text: string }[] }>` 로 타입을 바꾸고 `lines: logs.lines.slice(-80).map(l => redacted(l.text))`.

- [ ] **Step 3: README**

54행:
```
- 로그는 저장하지 않습니다. 워크플로·작업 화면의 로그는 Kubernetes API로 Pod에서 직접 읽으며(요청당 최대 5,000줄, SSE 55초 연결 후 타임스탬프로 재접속) Pod가 삭제되면 더 볼 수 없습니다. 주입된 자격증명은 시도별 불변 Secret을 근거로 서버에서 redaction합니다.
```
87행에서 `·\`LOG_ARCHIVE_ENABLED=0\`` 삭제.

- [ ] **Step 4: 기능 문서**

- 53행 원장 행의 `·로그 아카이브` 삭제(Task A에서 이미 outbox로 바꿨다면 그 문장 유지).
- 158행:
```
| **로그** | 태스크의 현재 Pod를 Kubernetes API에서 읽어 JSON 스냅샷(`tail` ≤5,000줄) 또는 SSE(`follow=1`, 55초 연결, `Last-Event-ID`=타임스탬프로 재접속)로 표시. 시도·멤버·컨테이너 선택. Pod 삭제 후에는 `pod-gone` 안내만 표시 | Kubernetes `pods/<name>/log`(`timestamps`, `sinceTime`). 대시보드는 로그를 저장하지 않음. redaction은 시도별 불변 Secret 기준 |
```
- 343행:
```
- **로그** 대화상자: Pod 선택, follow(2초 폴링), 검색, `.log` 다운로드. 소스는 kubelet `pods/<name>/log`이며 대시보드 관리 Pod는 시도별 Secret으로 redaction, 검증 불가 시 비관리자는 403.
```
- 522행에서 `LOG_ARCHIVE_ENABLED=1` 삭제.
- 536행에서 `로그 archive 64 MiB/65,536 records·30일` → `로그는 Pod 생존 중에만 조회(요청당 5,000줄, 1 MiB)`.

- [ ] **Step 5: 다이어그램**

`gen_diagrams.py:622` 라벨에서 `LOG_POD# 아카이브 · ` 삭제. 02 페이지 `logs` box 문구를 `"로그 탭: web 이 Kubernetes API pods/<name>/log 를 직접 읽어 SSE 로 전달(55초 연결 · 타임스탬프 재접속). 저장하지 않음 · Pod 삭제 후 pod-gone 안내 · 시도별 Secret 기준 redaction"`로. 02 페이지 `ctrl→ddb` 엣지 라벨 `"상태·이벤트·로그"` → `"상태·이벤트"`, `ctrl` 노드 라벨의 `로그 수집 · ` 삭제. `bash export.sh`로 재생성.

- [ ] **Step 6: 검증과 커밋**

Run: `cd dashboard/web && npm run typecheck && npm test && npx playwright test --list e2e/log-stream.spec.ts`
Expected: 통과, e2e는 목록에 나타남(실행은 배포 환경 필요).

```bash
git add -A dashboard/web/e2e dashboard/README.md dashboard/docs
git commit -m "test(dashboard): e2e for kubelet log streaming and pod-gone; document the no-storage log model

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```
