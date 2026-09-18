# Dashboard architecture simplification — HyperPod-native orchestration, single IaC, edge/ops hardening

Date: 2026-09-18. Branch: `feat/hyperpod-dashboard`. Scope: `dashboard/infra`, `dashboard/web/src/{worker.ts,server/workflow,server/workflow-adapters,server/store}`, `dashboard/terraform` (deletion), `dashboard/README.md`.

## 1. Goal

Bring the dashboard to a Well-Architected baseline by removing components that add state without adding safety, and by adding the two protections an internet-facing control plane is expected to have.

Three changes:

1. **Orchestration** — remove Step Functions, SQS (+DLQ), the `callbacks` DynamoDB table and the EventBridge rule. DynamoDB `store` (workflow items, transactional outbox, fenced run leases) becomes the single source of truth; HyperPod/Kubernetes (`activeDeadlineSeconds`) enforces deadlines on the cluster side.
2. **IaC** — keep CDK (`dashboard/infra`), delete the Terraform port (`dashboard/terraform`).
3. **Edge and operations** — AWS WAF on the ALB, ALB access logs, CloudWatch alarms wired to the existing SNS topic, S3 lifecycle on the artifacts bucket.

Non-goals: no change to authentication (ALB `authenticate-cognito`), Fargate service topology, workload compilation (JobSet/Kueue), artifact publication, SageMaker pipelines, DCV/SSM sessions, Greengrass, or any UI. No multi-region, no CloudFront.

## 2. Verified current state

All facts below were read from the tree on 2026-09-18.

### 2.1 What Step Functions actually does

`infra/lib/constructs/orchestration.ts:49-67` defines a STANDARD state machine with **one task state**: `SqsSendMessage` with `WAIT_FOR_TASK_TOKEN`, heartbeat 5 min, task timeout 7 days, then `Succeed`. It does not run the task DAG; `orchestration.ts:12` says so ("The worker owns the detailed task/group DAG").

Runtime protocol (`web/src/worker.ts:29-79`, `web/src/server/workflow-adapters/dispatch.ts`):

- web: `StartExecution(name = workflowId)` via the `dispatch` outbox entry (`outbox.ts:17-26`).
- controller: polls SQS; on `workflow.start` stores the task token in the `callbacks` table; every 20 s sends `SendTaskHeartbeat` for **every** stored token (`worker.ts:74`, `dispatch.ts:100-118`); on terminal status sends `SendTaskSuccess/Failure`.
- EventBridge: execution status change → SQS `workflow.execution-ended` → controller writes `orchestrationStatus`, `orchestrationError`, `computeResultBeforeOrchestrationFailure` (`dispatch.ts:38-58`).
- Gate: `execution.ts:480` refuses to create workloads until the `dispatch` outbox entry is delivered.

### 2.2 Safety mechanisms that exist independently of Step Functions

| Concern | Mechanism | Location |
|---|---|---|
| Submission durability | Workflow + tasks + outbox written in one DDB transaction; 5 s reconcile loop picks up PENDING workflows | `submission.ts:209-227`, `controller.ts:88-127` |
| Controller crash mid-run | Per-workflow run lease, 30 s TTL, renewed every ~10 s, conditional writes fenced on lease; another replica adopts on expiry | `lease.ts:9-43`, `repo.ts:373-424` |
| Retry of side effects | Outbox with exponential backoff capped at 300 s; terminal workflows with undelivered outbox are still revisited | `outbox.ts:45-53`, `controller.ts:98` |
| Deadlines | Workflow defaults `queue_timeout 6h`, `start_timeout 10m`, `exec_timeout 12h`; controller enforces each clock; compiler also sets Kubernetes `activeDeadlineSeconds = exec + start` on every Job | `schema.ts:132-134`, `compile.ts:541-561` |
| Controller liveness for the UI | Process-level `CONTROLLER` lease (60 s, renewed every 20 s) read by `controllerHealth()` | `worker.ts:75`, `services/overview.ts:70-79` |

Conclusion: Step Functions contributes (a) a 7-day outer timeout that is already dominated by the per-clock deadlines plus `activeDeadlineSeconds`, and (b) an execution-history audit trail duplicated by the workflow item. It costs one extra state store, O(active runs) heartbeat API calls every 20 s, `states:SendTask*` on `*`, and reconciliation code for disagreements between the three stores.

### 2.3 Readers of SFN-derived data

None. `orchestrationStatus`, `orchestrationError`, `computeResultBeforeOrchestrationFailure`, and workflow `executionArn` are written by `dispatch.ts`/`outbox.ts` and read by no component, API handler, or service (`grep` over `web/src` hits only `store/types.ts:18-20,38` and `dispatch.ts`). All other `executionArn` occurrences are SageMaker pipeline executions and are unrelated.

### 2.4 IaC

- CDK: original implementation, `README.md:67` documents `npx cdk deploy`, four assertion test files in `infra/test`, `infra/cdk.out.deploy/` synthesised 2026-09-18 11:57 (live stack).
- Terraform: added in one commit (`d790f12`), one test file, `terraform/terraform.tfstate` is 339 bytes (no resources) with a 694 KB `.backup` from 09:45 the same day → applied and destroyed; no live resources depend on it. Already drifting (Terraform-only `assets` bucket, `storage.tf:139-168`).

### 2.5 Edge and operations

- No WAF association on the ALB; no ALB access logs (`service.ts` has no `logAccessLogs`).
- No `cloudwatch.Alarm` anywhere in `infra/lib`.
- Artifacts bucket lifecycle: only `abortIncompleteMultipartUploadAfter: 2 days` (`orchestration.ts:47`); versioning on, so superseded checkpoint versions accumulate forever.
- SNS topic `<prefix>-notifications` already exists (`dashboard-stack.ts:103-104`) with optional email subscription.

## 3. Design

### 3.1 Orchestration: DynamoDB single ledger + cluster-side deadlines

**Submission.** Unchanged transaction in `submission.ts`. `createWorkflow` no longer seeds `dispatch`/`enqueue` outbox entries. `resumeSubmission` keeps the `deferLaunch` branch; otherwise it calls `reconcileWorkflowInternal` immediately (the branch that already exists at `submission.ts:225` when no dispatch port is configured). The 5 s reconcile loop remains the recovery path.

**Execution.** Delete the dispatch gate at `execution.ts:480`. Everything after it is unchanged.

**Completion.** Keep the `completeWorkflow` port (`ports.ts`) because production wraps it to enqueue webhooks (`dependencies.ts:18-22`). Its production implementation becomes webhook enqueue only; the SFN `SendTaskSuccess/Failure` half is deleted. Outbox kinds become `'complete' | 'notify'`.

**Deadlines.** No new field. The existing chain is the design: controller clocks (`queue`/`start`/`exec`) fail the workflow from the controller side; Kubernetes `activeDeadlineSeconds` kills the pod from the cluster side even if every controller replica is down. Document this chain in `workflow/README.md` under a new "Orchestration" heading (replacing the implicit reliance on the 7-day SFN timeout).

**Controller liveness.** `worker.ts`:

- Delete the SQS client, `receiveRequests()`, `heartbeatCallbacks()` call, and the three SFN/SQS env checks (`WORKFLOW_QUEUE_URL`, `WORKFLOW_STATE_MACHINE_ARN`, `WORKFLOW_CALLBACKS_TABLE`). `DASHBOARD_ARTIFACT_BUCKET` remains required.
- Keep the 20 s loop that renews the `CONTROLLER` lease.
- `/health` returns 200 when the last completed reconcile tick is ≤ 30 s old (three tick intervals). `controllerStatus().lastTick` already records this (`controller.ts:71,117`); no new state. This replaces "last successful SQS poll ≤ 120 s".
- Emit one CloudWatch EMF line per tick: `ReconcileLagSeconds` (now − previous tick end) and `ActiveRunLeases` (count of `WF#*/LEASE` items with `expires > now`, obtained from the reconcile pass that already pages every workflow). Namespace `PhysicalAI/Dashboard`, dimension `Service=controller`.

**Data model.** Remove from `Workflow` (`store/types.ts`): `executionArn`, `orchestrationStatus`, `orchestrationError`, `computeResultBeforeOrchestrationFailure`. Remove `'dispatch' | 'enqueue'` from `OutboxEntry.kind`. Remove `dispatchWorkflow` and `enqueueWorkflow` from `ControllerDeps`.

**Legacy items.** DynamoDB items written by the current code will still exist after deploy: `WF#<id>/OUT#dispatch`, `WF#<id>/OUT#enqueue`, and workflow attributes above. Rules:

- `listOutbox` filters to known kinds; unknown kinds are ignored (never retried, never block `finishWorkflow`). One-line filter in `repo.ts:listOutbox`.
- Unknown workflow attributes are simply not in the type; DynamoDB keeps them until the item is next rewritten. No migration job.

**Infra (CDK).** In `orchestration.ts` delete `dlq`, `queue`, `callbacks`, `dispatch`, `logGroup`, `stateMachine`, `terminalEvents`; the construct keeps only `artifacts` (rename the class to `ArtifactsConstruct` and the file to `artifacts.ts`; `dashboard-stack.ts:64,98,123,180,187-196,489` keep working with the new name). In `dashboard-stack.ts` delete env lines `120-122`, grants `179,185-186,197-204`, output `488`. `env-contract.ts` is unaffected (it never listed these keys). Delete `@aws-sdk/client-sfn` and `@aws-sdk/client-sqs` from `web/package.json`.

**Retained table.** `callbacks` has `RemovalPolicy.RETAIN`. Removing the construct orphans the table rather than deleting it. Runbook step after the deploy is healthy: `aws dynamodb delete-table --table-name <name>` where `<name>` is the physical ID of logical resource `Orchestration/Callbacks` in the CloudFormation stack (`aws cloudformation describe-stack-resource --stack-name PhysicalAiDashboard --logical-resource-id` on the `OrchestrationCallbacks*` resource) once `aws stepfunctions list-executions --status-filter RUNNING` on the old state machine is empty (the state machine itself is deleted by the stack; in-flight executions are aborted by that deletion, which is acceptable because the workflow items already carry the truth).

### 3.2 Single IaC: CDK

- Delete `dashboard/terraform/` entirely (verified: no live state).
- `dashboard/README.md:76` paragraph about Terraform deployment removed. `docs/plans/2026-09-18-*.md` are dated records and keep their historical mentions.
- No CDK behaviour change beyond §3.1 and §3.3.

### 3.3 Edge hardening (CDK, `service.ts`)

- **WAF**: `wafv2.CfnWebACL` scope `REGIONAL`, default allow, rules in order: `AWSManagedRulesCommonRuleSet` (override `SizeRestrictions_BODY` to `count` — workflow YAML and session transport bodies legitimately exceed 8 KB; browser uploads bypass the ALB via presigned S3 URLs and are unaffected), `AWSManagedRulesKnownBadInputsRuleSet`, and a rate-based rule of 2000 requests / 5 min per IP → block. `wafv2.CfnWebACLAssociation` to the ALB ARN. CloudWatch metrics enabled per rule; sampled requests on.
- **ALB access logs**: new S3 bucket `AccessLogs` (SSE-S3, block public, lifecycle expire 90 days), `alb.logAccessLogs(bucket, 'alb')`.

### 3.4 Operational alarms (CDK, new `constructs/alarms.ts`)

All alarms publish to the existing `notifications` SNS topic. Thresholds are starting points and are constants at the top of the file.

| Alarm | Metric | Threshold |
|---|---|---|
| `AlbTarget5xx` | `HTTPCode_Target_5XX_Count / RequestCount` (math) | > 5 % for 3 of 5 one-minute periods |
| `AlbTargetLatency` | `TargetResponseTime` p99 | > 5 s for 5 min |
| `ControllerReconcileLag` | `PhysicalAI/Dashboard ReconcileLagSeconds` max | > 60 s for 2 periods, treat missing data as breaching |
| `ControllerRunningTasks` | ECS `RunningTaskCount` for the controller service | < 1 for 3 min |
| `WafBlockedSpike` | `AWS/WAFV2 BlockedRequests` sum | > 500 in 5 min (visibility, not paging) |

### 3.5 Artifacts bucket lifecycle (`artifacts.ts`)

Add to the existing rule set: current objects transition to `INTELLIGENT_TIERING` after 30 days; noncurrent versions expire after 90 days; keep the 2-day multipart abort. `INTELLIGENT_TIERING` rather than `STANDARD_IA` because checkpoint read patterns are unknown and IA charges per retrieval.

## 4. Rollout

Precondition: `dashboard/infra/lib/dashboard-stack.ts` currently has uncommitted edits from another session (see `docs/plans/2026-09-18-dashboard-aws-architecture-ops.md`, constraint "no IAM changes … another session is editing"). This spec's implementation starts only after that work is committed; it must not be done in the same working tree concurrently. Use a worktree.

Order:

1. Code (§3.1 web changes) with tests green (`npx vitest run src/server/workflow src/server/store` and the full `web` suite).
2. CDK (§3.1 infra + §3.2 README) — one `cdk deploy`. The deploy removes the state machine, queues, EventBridge rule and orphans the retained table.
3. Runbook step: delete the retained `callbacks` table.
4. Delete `dashboard/terraform/`.
5. Second `cdk deploy` for §3.3–3.5 (WAF, logs, alarms, lifecycle). Separate so a WAF false positive is not confused with an orchestration regression.

Rollback for step 2 is `git revert` + `cdk deploy`; workflow items are forward/backward compatible because the removed fields were never read.

## 5. Testing

- **Unit (vitest)**: delete `workflow-adapters/dispatch.test.ts`. In `reliability.test.ts` delete the two SFN-specific cases (`:454-482` dispatch outbox retry, `:776-789` dispatch gate) and add: (a) a PENDING workflow with no dispatch port creates its workload on the first reconcile; (b) an outbox item with an unknown kind is ignored and does not block `finishWorkflow`; (c) `/health` predicate: 200 when `lastTick` ≤ 30 s old, 503 otherwise. Update the four stubs that pass `enqueueWorkflow`/`dispatchWorkflow` (`routing.test.ts:41-42`, `checkpoint-lineage.test.ts:79`, `image-pins.test.ts:113`).
- **CDK assertions**: delete `infra/test/orchestration.test.ts`; add `infra/test/edge-hardening.test.ts` asserting zero `AWS::StepFunctions::StateMachine`, zero `AWS::SQS::Queue`, one `AWS::WAFv2::WebACLAssociation`, five `AWS::CloudWatch::Alarm`, artifacts bucket lifecycle contains an `INTELLIGENT_TIERING` transition.
- **E2E**: existing `web/e2e/smoke.spec.ts` workflow submission path must pass unchanged against the deployed stack — it is the proof that submission → reconcile → workload works without SFN.

## 6. Out of scope (explicitly)

- Replacing the 5 s polling reconcile loop with DynamoDB Streams — polling is adequate at current scale and the loop is the recovery path.
- Multi-instance controller (`desiredCount > 1`); leases already make it safe but capacity planning is separate.
- Any change to `webhooks` (DynamoDB-ledger based, unaffected).
