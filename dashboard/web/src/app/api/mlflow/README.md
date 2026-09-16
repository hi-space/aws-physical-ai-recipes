# MLflow selected-project reads

`TrackingAccess` is the authorization boundary for browser-facing MLflow APIs. It uses the existing selected project (`requestProject`, including project-token context) and independently rechecks membership in the service.

- Experiments must have a nonempty name below `pai/<selectedProjectId>/`. Prefix collisions such as `pai/ab/` do not match project `a`.
- Every run must belong to an authorized experiment **and** contain exactly one `pai.project_id` tag with the selected project value. Legacy/untagged/conflicting-tag runs are excluded.
- Search requests carry server-generated namespace/tag filters. Results are also checked locally; upstream filters and caller-supplied run filters are not authorization.
- Explicit experiment IDs are checked individually, including multi-experiment searches. Concrete run detail and metric-history requests fetch current run/experiment metadata and authorize it before requesting subresources. They recheck ownership before returning the result.
- Admins use the same project filters in normal experiment/run views. `scope=legacy` or similar query strings do not bypass these routes.
- `/api/mlflow/models` is the explicit, admin-only legacy registered-model context. Project-bound tokens cannot use this global context.
- The parent-owned admin `/api/mlflow/ui-url` route and `server/tracking-proxy.ts` are unchanged.

This matches the real logging wrapper's experiment name `pai/<project>/<workflow>` and run ownership tag `pai.project_id`. It does not guess ownership from usernames, `run_name`, artifact paths, or membership in some other project.

Response shapes remain compatible with the current experiment UI:

| Route | Response |
|---|---|
| `GET /api/mlflow/experiments` | Scoped experiment array |
| `GET /api/mlflow/runs?experiment=<id,...>&filter=...&max=100` | Scoped run array |
| `GET /api/mlflow/runs/:id` | `{run, artifacts}` after authorization |
| `GET /api/mlflow/runs/:id/metrics?key=<key,...>` | Keyed metric-history arrays |
| `GET /api/mlflow/models` | Legacy registered-model array, admin only |

Query limits: 1–50 experiment IDs, 1–500 search results, filter length ≤4000, and 1–16 metric keys of ≤250 characters. Invalid requests return 400. Foreign/unproven run or experiment IDs return no data; scope mismatches return 404. Authorized upstream failures remain failures rather than fabricated empty results.

The AWS helper adds optional experiment filters and direct experiment lookup. Existing zero-argument internal/admin helper calls are retained. No IAM, tracking-proxy, UI-url, model-store or other UI changes are part of this task.

Validation uses fake MLflow transports and MemoryKV only:

```bash
npm --prefix dashboard/web test -- src/server/services/tracking-access.test.ts src/app/api/mlflow src/server/tracking-proxy.test.ts
npm --prefix dashboard/web test -- src/components/pages/ui-contracts.test.ts -t 'binds a verified modelId'
```

The second command verifies the separately authorized legacy edge contract update. Other test cases in that file were not modified.
