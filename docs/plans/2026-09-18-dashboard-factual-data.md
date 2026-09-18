# Dashboard: factual data only (no hard-coded infra facts, no unlabeled estimates)

Date: 2026-09-18. Scope: `dashboard/web`. Branch `feat/hyperpod-dashboard`.

## Why

An audit of every number the UI shows found three classes of non-factual content:

1. **Hard-coded infrastructure facts** that must come from AWS APIs instead:
   - `src/server/services/compute.ts:41-42` and `src/server/services/sessions.ts:479-480` — GPU-ness by regex `^ml\.(g|p)`, "system" group by name `head` / `cpu-c5-4x`.
   - `src/components/pages/QueuesPage.tsx:72,518,613` — six instance types typed into the quota dialog.
   - `src/server/aws/hyperpod-rates.ts` + `hyperpod-rates.json` — price list pinned to `us-east-1` and a bundled 2026-09-16 snapshot.
   - `us-east-1` literals in `backends/registry.ts`, `aws/ecr-inspection.ts`, `aws/source-builds.ts`, `services/source-builds-contract.ts`, `services/source-builds.ts`, `services/image-profiles.ts`, `components/pages/ComputePage.tsx:269`.
2. **Derived numbers shown without their basis**: Cost Explorer `Estimated` flag and cache time are fetched but never displayed (`aws/cost.ts:24`, `services/overview.ts:32`); only the top 12 services are listed while the total covers all; the home GPU figure is an instantaneous cluster-wide average labelled "평균 사용률".
3. **Dead catalog keys** in `messages/usage.ts` (`gpuCost`, `memRate`, `storageRate`, …) that imply a memory/storage cost model that does not exist.

## Rules for every change

- A number on screen must be traceable to an AWS API response, the Kubernetes API, or a DynamoDB record written from one of those. If it is derived (ratio, sum, estimate), the label says so and names the inputs.
- Configuration comes from `config()` (`src/server/config.ts`): region, cluster names, bucket names. No region, account ID, instance type, or group name literal in `src/server` or `src/components` outside tests.
- Form *defaults* are allowed only when they are the service's own default and the value is sent explicitly (nothing silently substituted server-side).
- All user-visible strings go through the message catalog (`useT`, `translate`). `ko` and `en` keys must match (compile-time).
- Do not commit. Do not touch files the other session is editing: `dashboard/infra/**`, `dashboard/terraform/**`, `src/server/aws/s3.ts`, `src/server/aws/sagemaker.ts`, `src/server/backends/probe.ts`, `src/server/services/pipelines*.ts`, `src/server/services/scaling-*.ts`, `src/server/workflow/compile*.ts`, `src/server/workflow/schema*.ts`, `src/server/workflow/groups.test.ts`, `src/server/workflow/topology/**`, `src/app/api/pipelines/executions/route.ts`, `e2e/smoke.spec.ts`.

## Work packages (disjoint files)

### WP1 — Instance catalog from EC2, cluster group facts (owner: agent "catalog")

Files: new `src/server/aws/instance-catalog.ts` (+ test), `src/server/services/compute.ts` (+ test), `src/server/services/sessions.ts` (GPU check only), `src/components/pages/ComputePage.tsx`, `src/lib/i18n/messages/compute.ts`.

- `instance-catalog.ts`: `describeInstanceTypes(names: string[])` → `Map<string, { vCpu?: number; memoryMiB?: number; gpuCount: number; gpuName?: string; gpuMemoryMiB?: number }>`; strips the `ml.` prefix (reuse `instanceType()` and the EC2 paging loop from `aws/hardware-inspection.ts`, do not duplicate the paging logic — export it from a shared helper if needed). In-process cache keyed by name, TTL 6 h (instance type specs do not change). Region from `config().region`. Failure → empty map (caller shows "unknown", never guesses).
- `compute.ts` `ClusterSummary.groups[]`: replace `isGpu`/`isSystem` with `gpuCount?: number` (from catalog; `undefined` when the catalog lookup failed), `vCpu?`, `memoryGiB?`, `gpuName?`, and `role?: 'controller' | 'login' | 'worker'`. Role is only set for Slurm clusters and only when it can be read from the cluster's `provisioning_parameters.json` (`InstanceGroups[].LifeCycleConfig.SourceS3Uri` + `/provisioning_parameters.json`, keys `controller_group`, `login_group`, `worker_groups[].instance_group_name`), fetched with the existing S3 helper; unreadable → `role` undefined. Keep `isGpu` as a derived boolean (`gpuCount > 0`) for `OverviewPage` compatibility until WP3 lands, and document it.
- `sessions.ts:479`: use the catalog (`gpuCount > 0`) instead of the regex; keep the head-node exclusion but derive it from `role === 'controller'` when known, otherwise from Slurm `role` unknown → do not exclude by name.
- `ComputePage.tsx`: show per group "인스턴스 유형 · vCPU · 메모리 · GPU n× <name> <mem>" from the new fields; role badge only when known; drop the `isSystem` opacity; the kubeconfig snippet uses `me.data.region` and `me.data.clusters.eksName` with no fallback literals (render nothing when missing).
- Tests: unit test for the catalog mapping (GPU/no GPU/unknown) and for `summarizeCluster` with a mocked catalog.

### WP2 — Price list: region from config, no bundled snapshot (owner: agent "pricing")

Files: `src/server/aws/hyperpod-rates.ts` (+ test), delete `src/server/aws/hyperpod-rates.json`, `src/server/services/usage.ts` (+ test), `src/app/api/usage/rates/route.ts`, `src/components/usage/UsageSummary.tsx`, `src/components/pages/UsagePage.tsx`, `src/components/pages/UsageScaling.browser.test.ts`, `src/lib/i18n/messages/usage.ts`.

- `RateSnapshot.region: string`; URL `https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonSageMaker/current/${region}/index.json` (the Price List Bulk API host is always `pricing.us-east-1.amazonaws.com`; only the path region varies). Validate `attributes.regionCode === region` and `usagetype` ends with `-Cluster:${instanceType}` (drop the `USE1-` literal). DynamoDB key `USAGE_PRICING#${region}`.
- Remove `BUNDLED_RATES` and the JSON. `readRates()` returns the stored snapshot or `undefined`. `ensureRates()` fetches and stores when there is no snapshot or it is older than 30 days (same conditional put as `refreshRates`, at most once per process per hour on failure). `services/usage.ts` calls `ensureRates()`; with no snapshot every amount is `null` with issue `no_rates`.
- `usage.ts`: move the Korean issue messages to catalog keys (`usage.issue_*`) — return `code` only, let the UI translate. Remove the dead keys from `messages/usage.ts` (`gpuCost`, `cpuCost`, `memoryCost`, `storageCost`, `hourly`, `daily`, `monthly`, `assumptions`, `gpuRate`, `cpuRate`, `memRate`, `storageRate`, `total`, `summary`, `gpu`, `cpu`, `memory`, `storage`, `cost`, `noData`) after confirming they are unused.
- `UsageSummary.tsx`: use `useFormat()` (`fmtNum`, `fmtUsd`) instead of the hard-coded `ko-KR` / `$` formatting; show `region`, `retrievedAt`, `publicationDate`, and the source link (accept any `https://pricing.us-east-1.amazonaws.com/` URL).
- Tests: rewrite `hyperpod-rates.test.ts` around a small inline offer-file fixture (two SKUs, one region); `UsageScaling.browser.test.ts` builds its snapshot from the same fixture helper (put it in `src/server/aws/hyperpod-rates.fixture.ts`, test-only import).

### WP3 — Cost, GPU, quota dialog facts (owner: agent "overview")

Files: `src/server/aws/cost.ts` (+ test), `src/server/services/overview.ts`, `src/app/api/cost/route.ts`, `src/components/pages/OverviewPage.tsx`, `src/components/pages/AdminPage.tsx` (CostTab only), `src/components/pages/QueuesPage.tsx`, `src/lib/i18n/messages/overview.ts`, `src/lib/i18n/messages/admin.ts` (cost keys only), `src/lib/i18n/messages/queues.ts`.

- `cost.ts`: return every service (no `slice(0, 12)`), plus `estimated`, `fetchedAt`, `start`, `end` (dates actually sent to Cost Explorer). `overview.ts` returns `cost.fetchedAt` from the cache entry. UI: "Cost Explorer · 조회 {fetchedAt} · {start}–{end}" under the headline; when `estimated` is true show "일부 금액은 Cost Explorer 추정치(미확정)입니다"; list top 10 by amount and one "기타 {n}개 서비스 US$x" row so bars sum to the total.
- Home GPU stat: label the sub-line "현재 평균 사용률 {value}% (전체 GPU, 순간값)" / "Current average utilization {value}% (all GPUs, instantaneous)"; N/A when AMP is not configured.
- Home cluster card: use `group.gpuCount` (WP1 field) — badge "GPU ×n" when `gpuCount > 0`, none when 0, "?" tone neutral when undefined.
- `QueuesPage.tsx`: the quota dialog loads `/api/clusters` and offers exactly the instance types present in the HyperPod EKS cluster's instance groups (deduplicated), defaulting to the first group with `gpuCount > 0`; when the list is empty the select is disabled with a message "클러스터 인스턴스 그룹을 조회하지 못했습니다". Send `fairShareWeight` explicitly (form default 50, shown in the field, matching the SageMaker default) so `hyperpod.ts:170` never substitutes.
- Tests: cost DTO test for `estimated`/`fetchedAt`/all services; QueuesPage instance-type option test with a mocked `/api/clusters`.

### WP4 — Region literals → `config().region` (owner: agent "region")

Files: `src/server/backends/registry.ts` (+ test), `src/server/aws/ecr-inspection.ts` (+ test), `src/server/aws/source-builds.ts` (+ test), `src/server/services/source-builds-contract.ts` (+ test), `src/server/services/source-builds.ts` (+ test), `src/server/services/image-profiles.ts` (+ test), `src/server/aws/clients.ts` (comment only: Cost Explorer's endpoint is global and must stay `us-east-1`).

- Replace each `us-east-1` literal with the home region from `config().region` (registry: `z.string()` then compare to `config().region` in the same place the account is compared). ECR registry host `${account}.dkr.ecr.${region}.amazonaws.com`; ECR layer bucket host list derived from the region (`prod-${region}-starport-layer-bucket`); CodeCommit host `git-codecommit.${region}.amazonaws.com`; connections ARN region.
- Error messages that mention the region use a placeholder and the actual region value.
- Tests keep passing with `AWS_REGION=us-east-1` in the test env and gain one case with another region (e.g. `us-west-2`) proving no literal remains.

### WP5 — Heading weight (owner: main session)

`src/components/layout/PageHeader.tsx`, `src/components/ui/index.tsx`: h1 `text-lg`, description 13 px, tighter bottom margin; card titles 13 px semibold; stat labels sentence case (no uppercase tracking).

## Verification

`cd dashboard/web && npx vitest run` (all), `npx tsc --noEmit`, `npm run build`. Then `grep -rn "us-east-1\|ml\.[a-z0-9]*\.[0-9]*x\?large\|'head'\|cpu-c5-4x" src --include=*.ts --include=*.tsx | grep -v test` must list only: `aws/clients.ts` (Cost Explorer endpoint), `aws/hyperpod-rates.ts` (Price List host), `workflow/builtin-templates.ts` (recipe resource defaults, validated at submit), `workflow-adapters/artifact-inventory.ts` (env-overridable), message catalogs.
