# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

MLOps Dashboard for monitoring IsaacLab reinforcement learning training fleets running on AWS. AWS EC2 Batch 환경에서 구동되는 다수의 IsaacLab 기반 RL 인스턴스를 통합 모니터링하기 위한 웹 대시보드.

Each EC2 worker runs an IsaacLab training process. Workers are orchestrated via AWS Batch (parallel execution) and use `torch.distributed` (DDP, NCCL backend) for multi-node distributed training. The dashboard provides:

1. **Fleet Monitoring** — EC2 instances and Batch jobs discovered by resource tags, with DDP topology visualization
2. **Native Rerun Visualization** — Clicking a worker embeds that worker's Rerun Web Viewer (WASM) in-browser via iframe (ports 9090/9876)
3. **TensorBoard Metrics** — Per-worker TensorBoard embed (port 6006) for reward curves, losses, and learning rate
4. **Experiment Comparison** — Reward overlay charts and hyperparameter diff tables across training runs

## Commands

- `yarn dev` — start dev server on port 3000
- `yarn build` — production build (Next.js standalone output)
- `yarn lint` — run Next.js ESLint
- `yarn start` — start production server on port 3000

## Architecture

**Next.js 14 App Router** with TypeScript + Tailwind CSS. All source code is under `src/`.

### Data Flow

The frontend fetches from three internal API routes that either call AWS SDKs or return mock data based on the `USE_MOCK_DATA` env var:

- `/api/workers` — EC2 `DescribeInstances`, filtered by resource tag. Maps EC2 instance state/tags to `Worker` objects.
- `/api/batch-jobs` — AWS Batch `ListJobs`/`DescribeJobs` across all queues, filtered by project tag.
- `/api/experiments` — Currently mock-only (returns from `src/data/mockWorkers.ts`). Intended to be backed by a metadata store.

API routes import shared AWS SDK clients from `@/lib/aws-clients` (EC2Client, BatchClient) configured via env vars.

### Client-Side State

`useWorkers` hook (`src/hooks/useWorkers.ts`) is the single state manager. It:
1. Fetches all three API endpoints on mount
2. Polls `/api/workers` and `/api/batch-jobs` every 30 seconds
3. Derives `regions`, `filteredWorkers`, and `summary` (FleetSummary) as memos

### Shell Pattern

`DashboardShell` wraps every page. It calls `useWorkers()` and passes the full context via render-prop `children(ctx)`. Pages (`/`, `/experiments`, `/worker/[workerId]`) consume this context without managing their own data fetching.

### Pages

| Route | Purpose |
|---|---|
| `/` | Fleet overview: summary cards, DDP topology SVG, sortable worker table |
| `/experiments` | Experiment cards, reward comparison SVG chart, hyperparameter diff table |
| `/worker/[workerId]` | Worker detail: info panel, training metrics, Rerun viewer, TensorBoard embed |

### Key Types

All domain types are in `src/types/worker.ts`: `Worker`, `Experiment`, `BatchJob`, `TrainingMetrics`, `FleetSummary`. Workers carry DDP metadata (rank, worldSize, backend) and ports for Rerun/TensorBoard.

## Environment Variables

Configured via `.env.local` (see `.env.local.example`):

- `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` — server-side only, used by API routes
- `AWS_RESOURCE_TAG_KEY` / `AWS_RESOURCE_TAG_VALUE` — tag filter for EC2/Batch resource discovery (default: `Project`/`IsaacLab-RL`)
- `USE_MOCK_DATA=true` — bypass AWS calls, serve mock data (default for local dev)

## Styling

Tailwind with custom AWS-themed colors: `aws-orange` (#FF9900), `aws-dark` (#232F3E), `aws-navy` (#1B2A4A). No component library — all UI is hand-built with Tailwind utility classes and inline SVG for charts/topology.

## Path Aliases

`@/*` maps to `./src/*` (configured in tsconfig.json).
