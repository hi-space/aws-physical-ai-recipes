# Dashboard Architecture Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove Step Functions/SQS/callbacks-table orchestration in favour of the existing DynamoDB outbox + fenced run leases + Kubernetes deadlines, delete the Terraform port, and add WAF, ALB access logs, CloudWatch alarms and an artifacts-bucket lifecycle.

**Architecture:** The controller (`dashboard/web/src/worker.ts`) already reconciles every non-terminal workflow every 5 s under a per-workflow DynamoDB lease; submission already writes workflow + tasks + outbox in one transaction. We delete the parallel Step Functions "outer lifecycle" and the SQS bridge that fed it, make `/health` depend on reconcile freshness instead of SQS polling, and emit EMF metrics from the reconcile tick so a CloudWatch alarm can page on stalls. CDK gains a WAF WebACL on the ALB, an access-log bucket, an alarms construct and lifecycle rules.

**Tech Stack:** TypeScript, Next.js standalone worker bundle (`scripts/build-services.mjs`), vitest (`dashboard/web`), AWS CDK v2 (`aws-cdk-lib ^2.269`) with `node:test` + `ts-node` (`dashboard/infra`), DynamoDB single-table store (`MemoryKV` in tests).

**Spec:** `docs/designs/2026-09-18-dashboard-architecture-simplification.md`

## Global Constraints

- Precondition (spec §4): `dashboard/infra/lib/dashboard-stack.ts` has uncommitted edits from another session. Do not start until `git status --short dashboard/infra` is clean, and work in a worktree (`superpowers:using-git-worktrees`).
- Never rename the CDK construct id `'Orchestration'` or its child id `'Artifacts'`: the artifacts S3 bucket's CloudFormation logical ID derives from that path and a rename would replace the bucket (spec §3.1 "Infra").
- Workflow YAML and the `Workflow` DynamoDB item must remain backward compatible; removed fields are never read (spec §2.3). No migration job.
- Deadlines: no new field. Existing chain is `queue_timeout 6h` / `start_timeout 10m` / `exec_timeout 12h` (`schema.ts:132-134`) plus Kubernetes `activeDeadlineSeconds` (`compile.ts:541-561`).
- Web tests: `cd dashboard/web && npx vitest run <path>`; full suite `npm test`; types `npm run typecheck`; worker bundle `npm run build:services`.
- CDK tests: `cd dashboard/infra && node --require ts-node/register --test test/<file>.test.ts` (verified command; there is no npm `test` script).
- Commit after every task. Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- No Hangul in `dashboard/web/src/components` / `src/app` (repo rule; this plan touches neither).

## File structure

| File | Responsibility after this plan |
|---|---|
| `dashboard/web/src/server/store/types.ts` | `Workflow` without SFN fields; `OutboxEntry.kind` = `'complete' \| 'notify'` |
| `dashboard/web/src/server/store/repo.ts` | `listOutbox` ignores legacy kinds |
| `dashboard/web/src/server/workflow/ports.ts` | `ControllerDeps` without `dispatchWorkflow`/`enqueueWorkflow` |
| `dashboard/web/src/server/workflow/outbox.ts` | delivers `complete` and `notify` only |
| `dashboard/web/src/server/workflow/submission.ts` | seeds no outbox kinds at creation; `deferLaunch` or immediate reconcile |
| `dashboard/web/src/server/workflow/execution.ts` | dispatch gate removed |
| `dashboard/web/src/server/workflow/controller.ts` | adds `reconcileFresh()` health predicate and `emfMetrics()` EMF line; tick emits metrics |
| `dashboard/web/src/server/workflow-adapters/dependencies.ts` | `completeWorkflow` = webhook enqueue only |
| `dashboard/web/src/server/workflow-adapters/dispatch.ts` (+test) | **deleted** |
| `dashboard/web/src/worker.ts` | no SQS; health from `reconcileFresh()` |
| `dashboard/infra/lib/constructs/artifacts.ts` | renamed from `orchestration.ts`; bucket only, with lifecycle |
| `dashboard/infra/lib/constructs/alarms.ts` | **new**: five CloudWatch alarms → SNS |
| `dashboard/infra/lib/constructs/service.ts` | adds WAF WebACL + association and ALB access logs |
| `dashboard/infra/lib/dashboard-stack.ts` | wires the above; no SFN/SQS env or IAM |
| `dashboard/infra/test/artifacts.test.ts`, `edge-hardening.test.ts` | replace `orchestration.test.ts` |
| `dashboard/terraform/**` | **deleted** |

Phases map to spec §4 rollout: **A** (Tasks 1–8) orchestration removal = first `cdk deploy`; **B** (Task 9) Terraform deletion; **C** (Tasks 10–12) hardening = second `cdk deploy`. Each phase is independently shippable.

---

## Phase A — Orchestration removal (web + CDK)

### Task 1: Store types and repo — drop SFN fields, tolerate legacy outbox items

**Files:**
- Modify: `dashboard/web/src/server/store/types.ts:17-20,38,256-257`
- Modify: `dashboard/web/src/server/store/repo.ts:448-450` (`listOutbox`)
- Test: `dashboard/web/src/server/store/outbox-legacy.test.ts` (new)

**Interfaces:**
- Produces: `OutboxEntry.kind: 'complete' | 'notify'`; `Repo.listOutbox(runId)` returns only those kinds.

- [ ] **Step 1: Write the failing test**

```ts
// dashboard/web/src/server/store/outbox-legacy.test.ts
import { describe, expect, it } from 'vitest';
import { MemoryKV } from './dynamo';
import { Repo } from './repo';

describe('outbox compatibility after Step Functions removal', () => {
  it('ignores legacy dispatch/enqueue outbox items written by the previous release', async () => {
    const kv = new MemoryKV();
    const repo = new Repo(kv);
    await kv.put({ pk: 'WF#legacy', sk: 'OUT#dispatch', kind: 'dispatch', attempts: 3, idempotencyKey: 'legacy:dispatch' });
    await kv.put({ pk: 'WF#legacy', sk: 'OUT#enqueue', kind: 'enqueue', attempts: 0, idempotencyKey: 'legacy:enqueue' });
    await kv.put({ pk: 'WF#legacy', sk: 'OUT#notify', kind: 'notify', attempts: 0, idempotencyKey: 'legacy:notify' });
    const entries = await repo.listOutbox('legacy');
    expect(entries.map(e => e.kind)).toEqual(['notify']);
  });

});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd dashboard/web && npx vitest run src/server/store/outbox-legacy.test.ts`
Expected: FAIL — returns `['dispatch','enqueue','notify']`.

- [ ] **Step 3: Edit `types.ts`**

Remove these four lines from `interface Workflow` (currently lines 18-20 and 38):

```ts
  orchestrationStatus?: string;
  orchestrationError?: string;
  computeResultBeforeOrchestrationFailure?: WorkflowStatus;
  executionArn?: string;
```

Change `OutboxEntry.kind` (line 257):

```ts
  kind: 'complete' | 'notify';
```

- [ ] **Step 4: Edit `repo.ts`**

Replace `listOutbox`:

```ts
  /** Kinds delivered by this release. Items from removed kinds (`dispatch`, `enqueue`) are ignored, never retried. */
  private static readonly OUTBOX_KINDS: ReadonlySet<string> = new Set(['complete', 'notify']);
  async listOutbox(runId: string) {
    return (await this.kv.query(`WF#${runId}`, 'OUT#'))
      .map(i => strip<OutboxEntry>(i))
      .filter(entry => Repo.OUTBOX_KINDS.has(entry.kind));
  }
```


- [ ] **Step 5: Run the test and the typecheck**

Run: `cd dashboard/web && npx vitest run src/server/store/outbox-legacy.test.ts && npm run typecheck`
Expected: test PASS. Typecheck FAILS in `outbox.ts`, `dispatch.ts`, `worker.ts`, `submission.ts` (they still reference removed kinds/fields) — that is expected and fixed in Tasks 2–5. Do not commit a red typecheck: proceed to Task 2 and commit both together only if Task 2 is small enough; otherwise commit now with the message below and note the transient typecheck failure in the commit body.

- [ ] **Step 6: Commit**

```bash
git add dashboard/web/src/server/store/types.ts dashboard/web/src/server/store/repo.ts dashboard/web/src/server/store/outbox-legacy.test.ts
git commit -m "refactor(dashboard): drop Step Functions fields from Workflow; ignore legacy outbox kinds

Typecheck is transiently red until the dispatch adapter is removed in the
following commits.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 2: Controller ports, outbox, submission and execution — remove dispatch/enqueue paths

**Files:**
- Modify: `dashboard/web/src/server/workflow/ports.ts:111-115`
- Modify: `dashboard/web/src/server/workflow/outbox.ts:17-29`
- Modify: `dashboard/web/src/server/workflow/submission.ts:209,221-225`
- Modify: `dashboard/web/src/server/workflow/execution.ts:480`
- Test: `dashboard/web/src/server/workflow/reliability.test.ts:454-482,776-789`

**Interfaces:**
- Consumes: `OutboxEntry.kind` from Task 1.
- Produces: `ControllerDeps` without `dispatchWorkflow`/`enqueueWorkflow`; `completeWorkflow?: (workflow, context: DeliveryContext) => Promise<void>` unchanged.

- [ ] **Step 1: Replace the two SFN-specific tests**

In `reliability.test.ts`, delete the whole `it('retries outbox start and terminal callbacks without launching duplicate jobs', …)` block (lines 454-482) and the top-level `it('does not start workloads while external orchestration dispatch is still unconfirmed', …)` block (lines 776-789). Insert in place of the first one:

```ts
  it('creates the workload on submission without any external dispatch step', async () => {
    const w = await submitWorkflow({ yaml, owner: 'a' }, deps);
    expect(k8s.creates).toBe(1);
    expect((await repo.getWorkflow(w.id))?.status).not.toBe('PENDING');
    expect((await repo.listOutbox(w.id)).map(e => e.kind)).toEqual([]);
  });
  it('retries the terminal completion callback without launching duplicate jobs', async () => {
    let callbacks = 0;
    deps.completeWorkflow = async () => {
      if (++callbacks === 1) throw new Error('callback unavailable');
    };
    const w = await submitWorkflow({ yaml, owner: 'a' }, deps);
    k8s.succeed((await repo.listTasks(w.id))[0].jobName!);
    expect((await reconcileWorkflow(w, deps)).status).toBe('SUCCEEDED');
    await vi.advanceTimersByTimeAsync(1000);
    await reconcileAll(deps);
    expect(callbacks).toBe(2);
    expect(k8s.creates).toBe(1);
  });
  it('deferLaunch still makes no Kubernetes calls until the first reconcile', async () => {
    const w = await submitWorkflow({ yaml, owner: 'a', deferLaunch: true }, deps);
    expect(k8s.creates).toBe(0);
    await reconcileWorkflow(w, deps);
    expect(k8s.creates).toBe(1);
  });
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `cd dashboard/web && npx vitest run src/server/workflow/reliability.test.ts -t "external dispatch|terminal completion|deferLaunch"`
Expected: FAIL to compile (`dispatch` kind no longer exists in `outbox.ts` types) or FAIL on `listOutbox(...).toEqual([])`.

- [ ] **Step 3: Edit `ports.ts`** — delete lines 111-115:

```ts
  dispatchWorkflow?: (workflow: Workflow, context: DeliveryContext) => Promise<{
    executionArn?: string;
  } | void>;
  enqueueWorkflow?: (workflow: Workflow, context: DeliveryContext) => Promise<void>;
```

- [ ] **Step 4: Edit `outbox.ts`** — replace lines 17-33 so the branch chain reads:

```ts
      if (entry.kind === 'complete') {
        if (!deps.completeWorkflow || !TERMINAL_WF.has(wf.status)) continue;
        await deps.completeWorkflow(wf, context);
        wf = (await deps.repo.getWorkflow(wf.id)) ?? wf;
      } else {
        const settings = await deps.repo.getSettings();
        if (settings.notifyOn.includes(wf.status as 'SUCCEEDED' | 'FAILED' | 'CANCELLED')) await deps.notify(`[Physical AI] workflow ${wf.name} ${wf.status}`, `Workflow ${wf.name} (${wf.id}) finished with status ${wf.status}.\n${wf.message ?? ''}`);
      }
```

- [ ] **Step 5: Edit `submission.ts`**

Line 209 — the fourth argument to `createWorkflow`: replace

```ts
  } : undefined, [...(deps.dispatchWorkflow ? ['dispatch' as const] : []), ...(deps.enqueueWorkflow ? ['enqueue' as const] : [])]);
```

with

```ts
  } : undefined);
```

Lines 221-225 — `resumeSubmission`:

```ts
async function resumeSubmission(wf: Workflow, input: SubmitInput, deps: ControllerDeps): Promise<Workflow> {
  if (!input.deferLaunch) await reconcileWorkflowInternal(wf, deps);
  return (await deps.repo.getWorkflow(wf.id))!;
}
```

If `withRunLease` / `deliverOutbox` imports in `submission.ts` become unused, remove them (typecheck will not complain — `noUnusedLocals` is off — but eslint may; run `npm run lint` if the script exists).

- [ ] **Step 6: Edit `execution.ts`** — delete line 480:

```ts
    if (!(await deps.repo.cancellation(wf.id)) && (await deps.repo.listOutbox(wf.id)).some(e => e.kind === 'dispatch' && !e.deliveredAt)) return wf;
```

- [ ] **Step 7: Run the workflow suites**

Run: `cd dashboard/web && npx vitest run src/server/workflow src/server/store`
Expected: PASS except `checkpoint-lineage.test.ts`, `image-pins.test.ts` (they set `enqueueWorkflow` — Task 3) and possibly `backends/routing.test.ts` (mocks the dispatch module — Task 3).

- [ ] **Step 8: Commit**

```bash
git add dashboard/web/src/server/workflow/ports.ts dashboard/web/src/server/workflow/outbox.ts dashboard/web/src/server/workflow/submission.ts dashboard/web/src/server/workflow/execution.ts dashboard/web/src/server/workflow/reliability.test.ts
git commit -m "refactor(dashboard): submission reconciles directly; remove dispatch gate and outbox kinds

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 3: Remove `enqueueWorkflow`/`dispatch` stubs from other test files

**Files:**
- Modify: `dashboard/web/src/server/workflow/checkpoint-lineage.test.ts:79`
- Modify: `dashboard/web/src/server/workflow/image-pins.test.ts:113`
- Modify: `dashboard/web/src/server/backends/routing.test.ts:41-44`

**Interfaces:**
- Consumes: `ControllerDeps` shape from Task 2 (no `enqueueWorkflow`).

- [ ] **Step 1: Run the three files to see the current failures**

Run: `cd dashboard/web && npx vitest run src/server/workflow/checkpoint-lineage.test.ts src/server/workflow/image-pins.test.ts src/server/backends/routing.test.ts`
Expected: type errors `Property 'enqueueWorkflow' does not exist` in the first two; `routing.test.ts` fails because `vi.mock('../workflow-adapters/dispatch', …)` targets a module that will not exist after Task 4 (it may still pass now — that is fine).

- [ ] **Step 2: Delete the stub lines**

`checkpoint-lineage.test.ts:79` and `image-pins.test.ts:113` — remove the line:

```ts
  f.deps.enqueueWorkflow = async () => {};
```

Both tests already pass `deferLaunch: true`; `resumeSubmission` (Task 2) keeps that branch, so they still make no Kubernetes calls.

`routing.test.ts:41-44` — remove the block:

```ts
vi.mock('../workflow-adapters/dispatch', () => ({
  dispatchWorkflow: async (wf: Workflow) => ({ executionArn: `home-sfn:${wf.id}` }),
  completeWorkflow: async () => undefined,
}));
```

If `Workflow` is now an unused import in that file, remove it from the import line.

- [ ] **Step 3: Run the three files**

Run: `cd dashboard/web && npx vitest run src/server/workflow/checkpoint-lineage.test.ts src/server/workflow/image-pins.test.ts src/server/backends/routing.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add dashboard/web/src/server/workflow/checkpoint-lineage.test.ts dashboard/web/src/server/workflow/image-pins.test.ts dashboard/web/src/server/backends/routing.test.ts
git commit -m "test(dashboard): drop dispatch/enqueue stubs

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 4: Production deps — completion is webhook-only; delete the dispatch adapter

**Files:**
- Modify: `dashboard/web/src/server/workflow-adapters/dependencies.ts:3,16,18-22`
- Delete: `dashboard/web/src/server/workflow-adapters/dispatch.ts`, `dashboard/web/src/server/workflow-adapters/dispatch.test.ts`
- Test: `dashboard/web/src/server/workflow-adapters/dependencies.test.ts` (new)

**Interfaces:**
- Produces: `productionControllerDeps().completeWorkflow(workflow, context)` → awaits `enqueueWorkflowWebhook(latestWorkflow)`; no AWS SDK calls.

- [ ] **Step 1: Write the failing test**

```ts
// dashboard/web/src/server/workflow-adapters/dependencies.test.ts
import { describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ webhook: [] as string[] }));
vi.mock('../services/webhooks', () => ({ enqueueWorkflowWebhook: async (wf: { id: string }) => { calls.webhook.push(wf.id); } }));
vi.mock('../store/repo', () => ({ getRepo: () => ({ getWorkflow: async (id: string) => ({ id, status: 'SUCCEEDED' }) }) }));
vi.mock('../workflow/controller', () => ({ realDeps: () => ({ repo: {}, k8s: {}, now: () => new Date() }) }));
vi.mock('./artifacts', () => ({ artifactPublisher: {}, cancelArtifactCollectors: async () => true }));
vi.mock('../runtime', () => ({ runtimeEnvironment: () => ({}), groupRuntime: {}, mintMetricsCapability: () => '', cleanupRuntimeUploads: async () => undefined }));
vi.mock('../k8s/resources', () => ({ getJobSet: vi.fn(), createJobSet: vi.fn(), deleteJobSet: vi.fn() }));
vi.mock('../services/profile-binding', () => ({ validateTaskImagePolicy: async () => undefined }));
vi.mock('../services/execution-profiles', () => ({ validateExecutionProfile: async () => undefined }));
vi.mock('./topology', () => ({ productionTopologyInventory: {} }));
vi.mock('./logs', () => ({ workflowLogHooks: () => ({}) }));

describe('productionControllerDeps', () => {
  it('completes a workflow by enqueuing its webhook only', async () => {
    const { productionControllerDeps } = await import('./dependencies');
    const deps = productionControllerDeps();
    expect('dispatchWorkflow' in deps).toBe(false);
    await deps.completeWorkflow!({ id: 'wf-1' } as never, { idempotencyKey: 'k', signal: new AbortController().signal });
    expect(calls.webhook).toEqual(['wf-1']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd dashboard/web && npx vitest run src/server/workflow-adapters/dependencies.test.ts`
Expected: FAIL — `'dispatchWorkflow' in deps` is `true`, and importing `./dispatch` requires `WORKFLOW_CALLBACKS_TABLE`/SFN client.

- [ ] **Step 3: Edit `dependencies.ts`**

Delete line 3 (`import { dispatchWorkflow, completeWorkflow } from './dispatch';`). Replace lines 16-22 with:

```ts
    ...base, artifactPublisher,
    ...(process.env.LOG_ARCHIVE_ENABLED === '1' ? { logs: workflowLogHooks(base.repo) } : {}),
    completeWorkflow: async (workflow, context) => {
      context.signal.throwIfAborted();
      await enqueueWorkflowWebhook(await getRepo().getWorkflow(workflow.id) ?? workflow);
    },
```

- [ ] **Step 4: Delete the adapter**

```bash
git rm dashboard/web/src/server/workflow-adapters/dispatch.ts dashboard/web/src/server/workflow-adapters/dispatch.test.ts
```

- [ ] **Step 5: Run the test**

Run: `cd dashboard/web && npx vitest run src/server/workflow-adapters`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add dashboard/web/src/server/workflow-adapters/dependencies.ts dashboard/web/src/server/workflow-adapters/dependencies.test.ts
git commit -m "refactor(dashboard): remove Step Functions dispatch adapter; completion enqueues webhooks only

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 5: Controller health predicate and EMF metrics; worker without SQS

**Files:**
- Modify: `dashboard/web/src/server/workflow/controller.ts:108-127` (`startController`), add two exported functions after `controllerStatus`
- Modify: `dashboard/web/src/worker.ts` (remove lines 3, 10, 24-70, 74; rewrite 95-97, 103; drop `receiveRequests()` from line 111)
- Test: `dashboard/web/src/server/workflow/controller.test.ts` (append a `describe`)

**Interfaces:**
- Produces:
  - `reconcileFresh(now?: number, maxAgeMs?: number, uptimeSeconds?: number): boolean` — true when the controller is running and `controllerStatus().lastTick` is ≤ `maxAgeMs` (default 30 000) old; before the first tick, true while `uptimeSeconds` (default `process.uptime()`) < 60.
  - `emfMetrics(values: Record<string, number>, timestamp?: number): string` — one CloudWatch Embedded Metric Format JSON line, namespace `PhysicalAI/Dashboard`, dimension `Service=controller`; keys ending in `Seconds` get unit `Seconds`, others `Count`.
  - Each reconcile tick logs `emfMetrics({ ReconcileLagSeconds?, ReconcileDurationSeconds, ActiveWorkflows })` to stdout (ECS awslogs → CloudWatch Logs extracts EMF automatically; no SDK dependency).

- [ ] **Step 1: Write the failing tests** (append to `controller.test.ts`)

```ts
import { controllerStatus, emfMetrics, reconcileFresh } from './controller';

describe('controller liveness', () => {
  it('is healthy only while reconcile ticks are fresh', () => {
    const status = controllerStatus();
    const now = Date.parse('2026-09-18T12:00:00Z');
    status.running = true;
    status.lastTick = new Date(now - 10_000).toISOString();
    expect(reconcileFresh(now, 30_000, 500)).toBe(true);
    status.lastTick = new Date(now - 31_000).toISOString();
    expect(reconcileFresh(now, 30_000, 500)).toBe(false);
    status.lastTick = undefined;
    expect(reconcileFresh(now, 30_000, 20)).toBe(true);
    expect(reconcileFresh(now, 30_000, 61)).toBe(false);
    status.running = false;
    status.lastTick = new Date(now - 1000).toISOString();
    expect(reconcileFresh(now, 30_000, 500)).toBe(false);
  });

  it('formats one embedded-metric-format line per tick', () => {
    const line = JSON.parse(emfMetrics({ ReconcileLagSeconds: 5.5, ActiveWorkflows: 3 }, 1_700_000_000_000));
    expect(line.Service).toBe('controller');
    expect(line.ReconcileLagSeconds).toBe(5.5);
    expect(line.ActiveWorkflows).toBe(3);
    expect(line._aws.Timestamp).toBe(1_700_000_000_000);
    expect(line._aws.CloudWatchMetrics).toEqual([{
      Namespace: 'PhysicalAI/Dashboard',
      Dimensions: [['Service']],
      Metrics: [{ Name: 'ReconcileLagSeconds', Unit: 'Seconds' }, { Name: 'ActiveWorkflows', Unit: 'Count' }],
    }]);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd dashboard/web && npx vitest run src/server/workflow/controller.test.ts -t "controller liveness"`
Expected: FAIL — `emfMetrics`/`reconcileFresh` are not exported.

- [ ] **Step 3: Add the functions to `controller.ts`** (after `export const controllerStatus = () => status;`)

```ts
/** ECS health: true while reconcile ticks keep landing; lenient for the first minute after boot. */
export function reconcileFresh(now = Date.now(), maxAgeMs = 30_000, uptimeSeconds = process.uptime()): boolean {
  if (!status.running) return false;
  if (!status.lastTick) return uptimeSeconds < 60;
  return now - Date.parse(status.lastTick) <= maxAgeMs;
}
/** CloudWatch Embedded Metric Format line; the awslogs driver ships it and CloudWatch extracts the metrics. */
export function emfMetrics(values: Record<string, number>, timestamp = Date.now()): string {
  return JSON.stringify({
    _aws: {
      Timestamp: timestamp,
      CloudWatchMetrics: [{
        Namespace: 'PhysicalAI/Dashboard',
        Dimensions: [['Service']],
        Metrics: Object.keys(values).map(name => ({ Name: name, Unit: name.endsWith('Seconds') ? 'Seconds' : 'Count' })),
      }],
    },
    Service: 'controller',
    ...values,
  });
}
```

Replace the `tick` body inside `startController` (lines 111-123) with:

```ts
  const tick = async () => {
    if (g.__paiControllerTick) return;
    g.__paiControllerTick = true;
    const started = Date.now();
    const previous = status.lastTick ? Date.parse(status.lastTick) : undefined;
    try {
      const active = await reconcileAll(realDeps());
      status.ticks++;
      status.lastTick = new Date().toISOString();
      status.lastError = undefined;
      console.log(emfMetrics({
        ...(previous !== undefined ? { ReconcileLagSeconds: (started - previous) / 1000 } : {}),
        ReconcileDurationSeconds: (Date.now() - started) / 1000,
        ActiveWorkflows: active,
      }));
    } catch (e) {
      status.lastError = e instanceof Error ? e.message : String(e);
    } finally {
      g.__paiControllerTick = false;
    }
  };
```

Also update the comment at line 42: `/** Process bootstrap hook for parent's artifact/runtime adapters. */`.

- [ ] **Step 4: Rewrite `worker.ts`**

Delete: line 3 (`@aws-sdk/client-sqs` import), line 10 (`dispatch` import), lines 24-27 (`sqs`, `lastQueuePoll`, keep `sleep`, delete `expiredToken`), the whole `receiveRequests` function (29-70), and line 74 (`await heartbeatCallbacks();`). Keep the `sleep` helper. Line 6 (`TERMINAL_WF`) and line 11 (`withRunLease`) become unused — delete them. Import `reconcileFresh` on line 7:

```ts
import { configureController, startController, stopController, controllerStatus, reconcileFresh } from './server/workflow/controller';
```

Lines 95-97 become:

```ts
  if (!process.env.DASHBOARD_ARTIFACT_BUCKET) throw new Error('DASHBOARD_ARTIFACT_BUCKET is required');
```

Line 103 becomes:

```ts
      const healthy = reconcileFresh();
```

Line 111: remove `receiveRequests(), ` from the `Promise.all([...])` list. The `heartbeat()` loop stays (it renews the `CONTROLLER` lease that `controllerHealth()` reads).

- [ ] **Step 5: Run tests, typecheck and the worker bundle**

Run: `cd dashboard/web && npx vitest run src/server/workflow/controller.test.ts && npm run typecheck && npm run build:services`
Expected: PASS / no type errors / `dist/services/controller.cjs` written. If `build:services` fails on a leftover `client-sqs` import, `grep -rn "client-sqs\|client-sfn" src` and remove it.

- [ ] **Step 6: Commit**

```bash
git add dashboard/web/src/worker.ts dashboard/web/src/server/workflow/controller.ts dashboard/web/src/server/workflow/controller.test.ts
git commit -m "feat(dashboard): controller health from reconcile freshness; EMF tick metrics; drop SQS consumer

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 6: Remove the SFN/SQS SDK dependencies and run the full web suite

**Files:**
- Modify: `dashboard/web/package.json:34,36` (+ `package-lock.json`)

- [ ] **Step 1: Confirm nothing imports them**

Run: `cd dashboard/web && grep -rn "@aws-sdk/client-sfn\|@aws-sdk/client-sqs" src scripts`
Expected: no output.

- [ ] **Step 2: Uninstall**

Run: `cd dashboard/web && npm uninstall @aws-sdk/client-sfn @aws-sdk/client-sqs`
Expected: both lines gone from `package.json`; lockfile updated.

- [ ] **Step 3: Full suite**

Run: `cd dashboard/web && npm test && npm run typecheck && npm run build:services`
Expected: all PASS. Known unrelated suites (`webhooks.test.ts`, `sessions/lifecycle.test.ts`) mention "complete"/"enqueue" names but never imported the deleted module — they must still pass.

- [ ] **Step 4: Commit**

```bash
git add dashboard/web/package.json dashboard/web/package-lock.json
git commit -m "chore(dashboard): remove Step Functions and SQS SDK clients

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 7: CDK — replace `OrchestrationConstruct` with `ArtifactsConstruct` (bucket only)

**Files:**
- Rename: `dashboard/infra/lib/constructs/orchestration.ts` → `dashboard/infra/lib/constructs/artifacts.ts`
- Modify: `dashboard/infra/lib/dashboard-stack.ts:18,64,98,120-123,179-180,185-204,488-489`
- Delete: `dashboard/infra/test/orchestration.test.ts`
- Test: `dashboard/infra/test/artifacts.test.ts` (new)

**Interfaces:**
- Produces: `class ArtifactsConstruct extends Construct { readonly bucket: s3.Bucket }`. **Construct ids are frozen**: the stack must instantiate it as `new ArtifactsConstruct(this, 'Orchestration')` and the bucket must keep child id `'Artifacts'`, so the bucket's CloudFormation logical ID (`OrchestrationArtifacts…`) is unchanged and the bucket is not replaced.

- [ ] **Step 1: Write the failing test**

```ts
// dashboard/infra/test/artifacts.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { ArtifactsConstruct } from '../lib/constructs/artifacts';

test('artifacts construct owns only the versioned, private bucket and keeps its logical id', () => {
  const stack = new cdk.Stack(new cdk.App(), 'Test', { env: { account: '123456789012', region: 'us-east-1' } });
  new ArtifactsConstruct(stack, 'Orchestration');
  const template = Template.fromStack(stack);
  template.resourceCountIs('AWS::StepFunctions::StateMachine', 0);
  template.resourceCountIs('AWS::SQS::Queue', 0);
  template.resourceCountIs('AWS::DynamoDB::Table', 0);
  template.resourceCountIs('AWS::Events::Rule', 0);
  template.resourceCountIs('AWS::S3::Bucket', 1);
  template.hasResource('AWS::S3::Bucket', {
    DeletionPolicy: 'Retain',
    Properties: Match.objectLike({
      VersioningConfiguration: { Status: 'Enabled' },
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
    }),
  });
  const [logicalId] = Object.keys(template.findResources('AWS::S3::Bucket'));
  assert.match(logicalId, /^OrchestrationArtifacts/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd dashboard/infra && node --require ts-node/register --test test/artifacts.test.ts`
Expected: FAIL — cannot find module `../lib/constructs/artifacts`.

- [ ] **Step 3: Create `artifacts.ts` and remove `orchestration.ts`**

```bash
cd dashboard/infra && git mv lib/constructs/orchestration.ts lib/constructs/artifacts.ts
```

Replace the file content with:

```ts
import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

/**
 * Workflow artifacts bucket (checkpoints, verified publications, presigned browser uploads).
 * Construct id 'Orchestration' and child id 'Artifacts' are frozen: the bucket's logical id derives from them.
 */
export class ArtifactsConstruct extends Construct {
  readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string) {
    super(scope, id);
    this.bucket = new s3.Bucket(this, 'Artifacts', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [{ abortIncompleteMultipartUploadAfter: cdk.Duration.days(2) }],
    });
  }
}
```

(The lifecycle transitions of spec §3.5 are added in Task 12, not here — Phase A must be a pure removal.)

- [ ] **Step 4: Edit `dashboard-stack.ts`**

Line 18: `import { ArtifactsConstruct } from './constructs/artifacts';`
Line 64: `const artifacts = new ArtifactsConstruct(this, 'Orchestration');`
Line 98: `artifacts.bucket.addCorsRule({`
Lines 120-123: delete the three `WORKFLOW_*` lines; keep `DASHBOARD_ARTIFACT_BUCKET: artifacts.bucket.bucketName,`
Line 179: delete `orchestration.stateMachine.grantStartExecution(role);`
Line 180: `artifacts.bucket.grantReadWrite(role);`
Lines 185-186: delete the `queue.grantConsumeMessages` and `callbacks.grantReadWriteData` lines.
Line 187: `artifacts.bucket.grantReadWrite(svc.controllerRole);`
Line 190: `resources: [artifacts.bucket.bucketArn],`
Line 195: `resources: [artifacts.bucket.arnForObjects('projects/*')],`
Lines 197-204: delete the `grantStartExecution(svc.controllerRole)` call and the two `states:*` `PolicyStatement`s.
Line 488: delete the `WorkflowStateMachineArn` output.
Line 489: `new cdk.CfnOutput(this, 'ArtifactBucketName', { value: artifacts.bucket.bucketName });`

Then `grep -n "orchestration\." lib/dashboard-stack.ts` must print nothing.

- [ ] **Step 5: Delete the old test; run CDK tests and synth**

```bash
cd dashboard/infra && git rm test/orchestration.test.ts
node --require ts-node/register --test test/artifacts.test.ts test/pipeline-permissions.test.ts test/source-build-project.test.ts test/optional-workload-images.test.ts
npx cdk synth -c domainName=d.example.com -c hostedZoneId=Z0 -c hostedZoneName=example.com --quiet
```
Expected: all tests PASS; synth succeeds. If `pipeline-permissions.test.ts` asserts `states:*` or `WORKFLOW_*` environment for a service, delete those assertions — they describe removed behaviour.

- [ ] **Step 6: Commit**

```bash
git add dashboard/infra/lib/constructs/artifacts.ts dashboard/infra/lib/dashboard-stack.ts dashboard/infra/test/artifacts.test.ts
git commit -m "infra(dashboard): remove Step Functions, SQS, callbacks table and EventBridge rule; keep artifacts bucket

Construct id 'Orchestration' is retained so the bucket logical id is unchanged.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 8: Documentation and runbook

**Files:**
- Modify: `dashboard/README.md:60`
- Modify: `dashboard/web/src/server/backends/README.md:47`
- Modify: `dashboard/web/src/server/workflow/README.md` (new section after "Submission and identity")

- [ ] **Step 1: `dashboard/README.md:60`** — replace the sentence

`DynamoDB가 실행/시도/소유권/lease 원장이며 Step Functions·SQS가 수명과 복구를 연결합니다.`

with

`DynamoDB가 실행/시도/소유권/lease/outbox 원장입니다. 컨트롤러는 5초마다 미완료 워크플로우를 lease 아래에서 reconcile하고, 데드라인은 워크플로우 `timeout`(queue/start/exec)과 Kubernetes Job `activeDeadlineSeconds`가 양쪽에서 집행합니다.`

- [ ] **Step 2: `backends/README.md:47`** — change `Home DDB, Cognito/SSM, SFN/SQS, archive bucket and native SageMaker pipeline/MLflow configuration remain home.` to `Home DDB, Cognito/SSM, archive bucket and native SageMaker pipeline/MLflow configuration remain home.`

- [ ] **Step 3: `workflow/README.md`** — insert after the "Submission and identity" section:

```markdown
## Orchestration

There is no external workflow engine. The DynamoDB store is the only ledger:

- Submission writes the workflow, its tasks and the outbox in one transaction, then reconciles immediately unless `deferLaunch` is set. The controller's 5 s `reconcileAll` loop is the recovery path for anything not yet started or not yet finished.
- Every reconcile of a workflow runs under a 30 s run lease (`lease.ts`); durable writes are conditioned on the lease. A replica that dies mid-run is superseded when its lease expires.
- Side effects that must happen after a terminal status (`complete` → webhooks, `notify` → SNS) are outbox entries retried with bounded exponential backoff; terminal workflows with undelivered entries are still visited.
- Deadlines are enforced twice: the controller applies `queue_timeout` / `start_timeout` / `exec_timeout` (defaults 6h / 10m / 12h), and the compiler sets Kubernetes `activeDeadlineSeconds = exec + start` on every Job so the cluster ends the pod even if no controller is running.
- Controller health (`/health` on :3001) is "a reconcile tick completed within 30 s"; each tick also logs EMF metrics `ReconcileLagSeconds`, `ReconcileDurationSeconds`, `ActiveWorkflows` (namespace `PhysicalAI/Dashboard`).

Outbox items of the removed kinds `dispatch` and `enqueue` may still exist for runs created before this release; `Repo.listOutbox` ignores them.

### Post-deploy cleanup (one time)

The former `callbacks` DynamoDB table had `RemovalPolicy.RETAIN`, so the first deploy of this release orphans it. After the controller is healthy:

```bash
aws cloudformation list-stack-resources --stack-name PhysicalAiDashboard \
  --query "StackResourceSummaries[?starts_with(LogicalResourceId,'OrchestrationCallbacks')].PhysicalResourceId"
# The command prints nothing once the resource has left the stack; use the table name printed *before* the deploy, or list tables:
aws dynamodb list-tables --query "TableNames[?contains(@,'OrchestrationCallbacks')]"
aws dynamodb delete-table --table-name <that name>
```
```

- [ ] **Step 4: Check no stale references remain**

Run: `grep -rn "Step Functions\|SFN\|SQS\|stateMachine\|WORKFLOW_QUEUE_URL\|WORKFLOW_STATE_MACHINE_ARN\|WORKFLOW_CALLBACKS_TABLE" dashboard/web/src dashboard/infra dashboard/README.md | grep -v node_modules | grep -v "\.test\.ts" `
Expected: only the historical mention in `workflow/README.md` ("removed kinds") and the runbook.

- [ ] **Step 5: Commit**

```bash
git add dashboard/README.md dashboard/web/src/server/backends/README.md dashboard/web/src/server/workflow/README.md
git commit -m "docs(dashboard): describe DynamoDB-only orchestration and the callbacks-table cleanup

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

**Phase A deploy gate:** `cd dashboard/infra && npx cdk diff` must show removal of `AWS::StepFunctions::StateMachine`, two `AWS::SQS::Queue`, one `AWS::DynamoDB::Table` (retained), one `AWS::Events::Rule`, and **no** change to the `OrchestrationArtifacts*` bucket. Then `npx cdk deploy` with the context documented in `dashboard/README.md:67-72`, followed by the runbook in Task 8 Step 3 and the e2e smoke run: `cd dashboard/web && npx playwright test e2e/smoke.spec.ts`.

---

## Phase B — Single IaC

### Task 9: Delete the Terraform port

**Files:**
- Delete: `dashboard/terraform/**`
- Modify: `dashboard/README.md:76`

- [ ] **Step 1: Confirm no live state** (spec §2.4)

Run: `cd dashboard/terraform && python3 -c "import json;print(len(json.load(open('terraform.tfstate')).get('resources',[])))"`
Expected: `0`. If not 0, STOP and ask — the spec's premise is wrong.

- [ ] **Step 2: Delete**

```bash
git rm -r dashboard/terraform
rm -rf dashboard/terraform   # removes ignored .terraform/ and tfstate backups
```

- [ ] **Step 3: `dashboard/README.md:76`** — delete the paragraph beginning `Terraform으로 배포하려면 \`dashboard/terraform/\`을 사용합니다`.

- [ ] **Step 4: Verify**

Run: `grep -rn "terraform" dashboard --include=*.md --include=*.ts --include=*.json -il | grep -v node_modules`
Expected: no output. (`docs/plans/*.md` historical mentions are intentionally left.)

- [ ] **Step 5: Commit**

```bash
git add -A dashboard/terraform dashboard/README.md
git commit -m "chore(dashboard): remove Terraform port; CDK is the single deployment path

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Phase C — Edge and operations hardening (second `cdk deploy`)

All three tasks share one full-stack assertion test file so the stack is synthesised once per run.

### Task 10: WAF WebACL and ALB access logs

**Files:**
- Modify: `dashboard/infra/lib/constructs/service.ts` (imports; after the `Http` listener at ~line 254)
- Test: `dashboard/infra/test/edge-hardening.test.ts` (new)

**Interfaces:**
- Produces: `ServiceConstruct.webAcl: wafv2.CfnWebACL` (name `${namePrefix}-web`) and `ServiceConstruct.accessLogs: s3.Bucket`. Task 11 reads `webAcl.name`.

- [ ] **Step 1: Write the failing test** (full-stack synth helper copied from `pipeline-permissions.test.ts:26-55`)

```ts
// dashboard/infra/test/edge-hardening.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { DashboardStack } from '../lib/dashboard-stack';

const accountId = '913524902871';
const region = 'us-east-1';

function synthesize() {
  const outputRoot = path.resolve(__dirname, '../cdk.out');
  fs.mkdirSync(outputRoot, { recursive: true });
  const outdir = fs.mkdtempSync(path.join(outputRoot, 'edge-test-'));
  try {
    const app = new cdk.App({ outdir, context: { 'aws:cdk:asset-staging': false } });
    const stack = new DashboardStack(app, 'EdgeHardening', {
      env: { account: accountId, region },
      accountId,
      region,
      discovered: { accountId, region },
      network: {
        vpcId: 'vpc-0123456789abcdef0',
        azs: ['us-east-1a', 'us-east-1b'],
        publicSubnetIds: ['subnet-00000000000000001', 'subnet-00000000000000002'],
        privateSubnetIds: ['subnet-00000000000000003', 'subnet-00000000000000004'],
        vpcCidr: '10.0.0.0/16',
      },
      domainName: 'dashboard.example.com',
      hostedZoneId: 'Z0123456789ABCDEF',
      hostedZoneName: 'example.com',
      adminUsername: 'admin',
      adminEmail: 'admin@example.com',
      webAppPath: path.resolve(__dirname, '../../web'),
      buckets: [],
    });
    return Template.fromStack(stack);
  } finally {
    fs.rmSync(outdir, { recursive: true, force: true });
  }
}

const template = synthesize();

test('no workflow engine resources remain', () => {
  template.resourceCountIs('AWS::StepFunctions::StateMachine', 0);
  template.resourceCountIs('AWS::SQS::Queue', 0);
  template.resourceCountIs('AWS::Events::Rule', 0);
});

test('the ALB is fronted by a regional WAF with managed rules, a rate limit and access logs', () => {
  template.resourceCountIs('AWS::WAFv2::WebACLAssociation', 1);
  template.hasResourceProperties('AWS::WAFv2::WebACL', Match.objectLike({
    Scope: 'REGIONAL',
    DefaultAction: { Allow: {} },
    Rules: Match.arrayWith([
      Match.objectLike({ Name: 'AWSManagedRulesCommonRuleSet', Statement: Match.objectLike({ ManagedRuleGroupStatement: Match.objectLike({
        RuleActionOverrides: [{ Name: 'SizeRestrictions_BODY', ActionToUse: { Count: {} } }] }) }) }),
      Match.objectLike({ Name: 'AWSManagedRulesKnownBadInputsRuleSet' }),
      Match.objectLike({ Name: 'RateLimitPerIp', Action: { Block: {} }, Statement: { RateBasedStatement: { Limit: 2000, AggregateKeyType: 'IP' } } }),
    ]),
  }));
  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', Match.objectLike({
    LoadBalancerAttributes: Match.arrayWith([{ Key: 'access_logs.s3.enabled', Value: 'true' }]),
  }));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd dashboard/infra && node --require ts-node/register --test test/edge-hardening.test.ts`
Expected: first test PASS (Task 7 done), second FAIL — 0 `WebACLAssociation`.

- [ ] **Step 3: Edit `service.ts`**

Add imports:

```ts
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
```

Add public fields next to the others:

```ts
  readonly webAcl: wafv2.CfnWebACL;
  readonly accessLogs: s3.Bucket;
```

Append at the end of the constructor (after the `Http` listener line):

```ts
    // ---- Edge protection
    this.accessLogs = new s3.Bucket(this, 'AccessLogs', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      lifecycleRules: [{ expiration: cdk.Duration.days(90) }],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    this.loadBalancer.logAccessLogs(this.accessLogs, 'alb');

    const visibility = (metricName: string) => ({ cloudWatchMetricsEnabled: true, sampledRequestsEnabled: true, metricName });
    const managed = (name: string, priority: number, overrides?: wafv2.CfnWebACL.RuleActionOverrideProperty[]): wafv2.CfnWebACL.RuleProperty => ({
      name, priority, overrideAction: { none: {} }, visibilityConfig: visibility(name),
      statement: { managedRuleGroupStatement: { vendorName: 'AWS', name, ...(overrides ? { ruleActionOverrides: overrides } : {}) } },
    });
    this.webAcl = new wafv2.CfnWebACL(this, 'WebAcl', {
      name: `${props.namePrefix}-web`,
      scope: 'REGIONAL',
      defaultAction: { allow: {} },
      visibilityConfig: visibility(`${props.namePrefix}-web`),
      rules: [
        // Workflow YAML submissions and session transports legitimately exceed the 8 KB body rule; browser uploads go to S3 directly.
        managed('AWSManagedRulesCommonRuleSet', 10, [{ name: 'SizeRestrictions_BODY', actionToUse: { count: {} } }]),
        managed('AWSManagedRulesKnownBadInputsRuleSet', 20),
        {
          name: 'RateLimitPerIp', priority: 30, action: { block: {} }, visibilityConfig: visibility('RateLimitPerIp'),
          statement: { rateBasedStatement: { limit: 2000, aggregateKeyType: 'IP' } },
        },
      ],
    });
    new wafv2.CfnWebACLAssociation(this, 'WebAclAssociation', { resourceArn: this.loadBalancer.loadBalancerArn, webAclArn: this.webAcl.attrArn });
```

- [ ] **Step 4: Run the test**

Run: `cd dashboard/infra && node --require ts-node/register --test test/edge-hardening.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add dashboard/infra/lib/constructs/service.ts dashboard/infra/test/edge-hardening.test.ts
git commit -m "infra(dashboard): WAF managed rules + per-IP rate limit on the ALB; access logs to S3

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 11: CloudWatch alarms construct

**Files:**
- Create: `dashboard/infra/lib/constructs/alarms.ts`
- Modify: `dashboard/infra/lib/dashboard-stack.ts` (import; instantiate after `svc` and `topic` exist)
- Test: `dashboard/infra/test/edge-hardening.test.ts` (append)

**Interfaces:**
- Consumes: `svc.loadBalancer`, `svc.controllerService`, `svc.webAcl` (Task 10), `topic` (existing SNS topic), cluster name `prefix`.
- Produces: `class AlarmsConstruct` with props `{ loadBalancer: elbv2.ApplicationLoadBalancer; controllerService: ecs.FargateService; clusterName: string; webAclName: string; topic: sns.ITopic }` creating exactly five `AWS::CloudWatch::Alarm`.

- [ ] **Step 1: Append the failing test**

```ts
test('five operational alarms notify the existing SNS topic', () => {
  template.resourceCountIs('AWS::CloudWatch::Alarm', 5);
  const alarms = Object.values(template.findResources('AWS::CloudWatch::Alarm'));
  for (const alarm of alarms) assert.equal(alarm.Properties.AlarmActions.length, 1, 'every alarm must have one action');
  const names = alarms.map(alarm => alarm.Properties.AlarmName).sort();
  assert.deepEqual(names.map((name: string) => name.replace(/^.*-/, '')), ['AlbTarget5xx', 'AlbTargetLatency', 'ControllerReconcileLag', 'ControllerRunningTasks', 'WafBlockedSpike'].sort());
  template.hasResourceProperties('AWS::CloudWatch::Alarm', Match.objectLike({
    Namespace: 'PhysicalAI/Dashboard', MetricName: 'ReconcileLagSeconds', Threshold: 60, TreatMissingData: 'breaching',
  }));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd dashboard/infra && node --require ts-node/register --test test/edge-hardening.test.ts`
Expected: FAIL — 0 alarms.

- [ ] **Step 3: Create `alarms.ts`**

```ts
import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';

export interface AlarmsConstructProps {
  namePrefix: string;
  loadBalancer: elbv2.ApplicationLoadBalancer;
  controllerService: ecs.FargateService;
  clusterName: string;
  webAclName: string;
  topic: sns.ITopic;
}

// Starting thresholds; tune from observed baselines.
const TARGET_5XX_PERCENT = 5;
const TARGET_P99_SECONDS = 5;
const RECONCILE_LAG_SECONDS = 60;
const WAF_BLOCKED_PER_5MIN = 500;

/** Operational alarms → the dashboard notifications topic. */
export class AlarmsConstruct extends Construct {
  constructor(scope: Construct, id: string, props: AlarmsConstructProps) {
    super(scope, id);
    const minute = cdk.Duration.minutes(1);
    const action = new cwActions.SnsAction(props.topic);
    const alarm = (name: string, metric: cloudwatch.IMetric, options: Partial<cloudwatch.CreateAlarmOptions> & Pick<cloudwatch.CreateAlarmOptions, 'threshold' | 'evaluationPeriods'>) => {
      const created = new cloudwatch.Alarm(this, name, {
        alarmName: `${props.namePrefix}-${name}`,
        metric,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        ...options,
      });
      created.addAlarmAction(action);
      return created;
    };

    const requests = props.loadBalancer.metrics.requestCount({ period: minute, statistic: 'Sum' });
    const errors = props.loadBalancer.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT, { period: minute, statistic: 'Sum' });
    alarm('AlbTarget5xx', new cloudwatch.MathExpression({
      expression: 'IF(requests > 0, 100 * errors / requests, 0)',
      usingMetrics: { requests, errors },
      period: minute,
      label: 'target 5xx %',
    }), { threshold: TARGET_5XX_PERCENT, evaluationPeriods: 5, datapointsToAlarm: 3, comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD });

    alarm('AlbTargetLatency', props.loadBalancer.metrics.targetResponseTime({ period: minute, statistic: 'p99' }),
      { threshold: TARGET_P99_SECONDS, evaluationPeriods: 5, comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD });

    alarm('ControllerReconcileLag', new cloudwatch.Metric({
      namespace: 'PhysicalAI/Dashboard', metricName: 'ReconcileLagSeconds', dimensionsMap: { Service: 'controller' }, statistic: 'Maximum', period: minute,
    }), { threshold: RECONCILE_LAG_SECONDS, evaluationPeriods: 2, comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD, treatMissingData: cloudwatch.TreatMissingData.BREACHING });

    alarm('ControllerRunningTasks', new cloudwatch.Metric({
      namespace: 'ECS/ContainerInsights', metricName: 'RunningTaskCount',
      dimensionsMap: { ClusterName: props.clusterName, ServiceName: props.controllerService.serviceName }, statistic: 'Minimum', period: minute,
    }), { threshold: 1, evaluationPeriods: 3, comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD, treatMissingData: cloudwatch.TreatMissingData.BREACHING });

    alarm('WafBlockedSpike', new cloudwatch.Metric({
      namespace: 'AWS/WAFV2', metricName: 'BlockedRequests',
      dimensionsMap: { WebACL: props.webAclName, Region: cdk.Stack.of(this).region, Rule: 'ALL' }, statistic: 'Sum', period: cdk.Duration.minutes(5),
    }), { threshold: WAF_BLOCKED_PER_5MIN, evaluationPeriods: 1, comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD });
  }
}
```

- [ ] **Step 4: Wire it in `dashboard-stack.ts`**

Add `import { AlarmsConstruct } from './constructs/alarms';` next to the other construct imports. After the `svc` (`ServiceConstruct`) instantiation and once `topic` exists, add:

```ts
    new AlarmsConstruct(this, 'Alarms', {
      namePrefix: prefix,
      loadBalancer: svc.loadBalancer,
      controllerService: svc.controllerService,
      clusterName: prefix,
      webAclName: `${prefix}-web`,
      topic,
    });
```

(`prefix` is the same value passed as `namePrefix` to `ServiceConstruct` and used as the ECS cluster name at `service.ts:83`.)

- [ ] **Step 5: Run the test**

Run: `cd dashboard/infra && node --require ts-node/register --test test/edge-hardening.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add dashboard/infra/lib/constructs/alarms.ts dashboard/infra/lib/dashboard-stack.ts dashboard/infra/test/edge-hardening.test.ts
git commit -m "infra(dashboard): CloudWatch alarms for ALB errors/latency, controller reconcile lag and task count, WAF blocks

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 12: Artifacts bucket lifecycle

**Files:**
- Modify: `dashboard/infra/lib/constructs/artifacts.ts` (lifecycle rules)
- Test: `dashboard/infra/test/artifacts.test.ts` (append)

- [ ] **Step 1: Append the failing test**

```ts
test('artifact objects tier down after 30 days and superseded versions expire after 90', () => {
  const stack = new cdk.Stack(new cdk.App(), 'Lifecycle', { env: { account: '123456789012', region: 'us-east-1' } });
  new ArtifactsConstruct(stack, 'Orchestration');
  Template.fromStack(stack).hasResourceProperties('AWS::S3::Bucket', Match.objectLike({
    LifecycleConfiguration: { Rules: Match.arrayWith([
      Match.objectLike({ Status: 'Enabled', Transitions: [{ StorageClass: 'INTELLIGENT_TIERING', TransitionInDays: 30 }], NoncurrentVersionExpiration: { NoncurrentDays: 90 } }),
      Match.objectLike({ Status: 'Enabled', AbortIncompleteMultipartUpload: { DaysAfterInitiation: 2 } }),
    ]) },
  }));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd dashboard/infra && node --require ts-node/register --test test/artifacts.test.ts`
Expected: the new test FAILS (no `Transitions`).

- [ ] **Step 3: Edit `artifacts.ts`** — replace the `lifecycleRules` array:

```ts
      lifecycleRules: [
        { abortIncompleteMultipartUploadAfter: cdk.Duration.days(2) },
        {
          // Checkpoint access patterns are unknown; Intelligent-Tiering has no retrieval fee, unlike IA.
          transitions: [{ storageClass: s3.StorageClass.INTELLIGENT_TIERING, transitionAfter: cdk.Duration.days(30) }],
          noncurrentVersionExpiration: cdk.Duration.days(90),
        },
      ],
```

- [ ] **Step 4: Run all CDK tests**

Run: `cd dashboard/infra && node --require ts-node/register --test test/*.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/infra/lib/constructs/artifacts.ts dashboard/infra/test/artifacts.test.ts
git commit -m "infra(dashboard): artifacts bucket lifecycle (Intelligent-Tiering after 30d, old versions expire after 90d)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

**Phase C deploy gate:** `npx cdk diff` shows one `WebACL`, one `WebACLAssociation`, one access-log bucket, five alarms, one bucket lifecycle update, and nothing else. Deploy. Then watch `AWS/WAFV2 CountedRequests` for the `SizeRestrictions_BODY` rule for a day before considering moving it back to block; confirm `ReconcileLagSeconds` datapoints appear in `PhysicalAI/Dashboard` (if not, the EMF line is not reaching CloudWatch Logs — check the controller's awslogs configuration).

---

## Rollout checklist (spec §4)

1. [ ] `git status --short dashboard/infra` is clean; you are in a worktree.
2. [ ] Phase A Tasks 1–8 committed; `cd dashboard/web && npm test && npm run typecheck && npm run build:services` green; `cd dashboard/infra && node --require ts-node/register --test test/*.test.ts` green.
3. [ ] `npx cdk diff` reviewed against the Phase A deploy gate; `npx cdk deploy`.
4. [ ] Controller task healthy (ECS console or `aws ecs describe-services`); `/health` 200; smoke e2e passes.
5. [ ] Runbook: delete the retained callbacks table.
6. [ ] Phase B Task 9 committed.
7. [ ] Phase C Tasks 10–12 committed; `npx cdk diff` reviewed against the Phase C deploy gate; `npx cdk deploy`.
8. [ ] Alarms visible in CloudWatch with `OK` state; one test alarm fired manually (`aws cloudwatch set-alarm-state --alarm-name <prefix>-ControllerReconcileLag --state-value ALARM --state-reason test`) reaches the SNS subscribers.

## Spec coverage

| Spec section | Task |
|---|---|
| §3.1 submission / execution / completion | 2, 4 |
| §3.1 controller liveness + EMF | 5 |
| §3.1 data model + legacy items | 1 |
| §3.1 infra (CDK) + retained table runbook | 7, 8 |
| §3.2 single IaC | 9 |
| §3.3 WAF + access logs | 10 |
| §3.4 alarms | 11 |
| §3.5 lifecycle | 12 |
| §5 testing | every task's test steps; e2e in the deploy gates |
