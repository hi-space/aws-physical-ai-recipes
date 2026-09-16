# Live researcher integration tests

Run **only after the parent confirms the new deployment**. These are real
integration tests: they submit CPU Jobs, publish/read artifacts, upload and
finalize a dataset, hydrate it in a second consumer run, and open terminal/file
sessions. They do not mock the backend, substitute cached sample outputs, skip
unsupported features, read AWS profiles/secrets, or use the AWS CLI/SDK.
When enabled, signed object transfers use only URLs returned by the dashboard.

The existing `smoke.spec.ts` and global Playwright configuration are unchanged.
This suite uses the same Cognito hosted-UI selectors and auth variables:

* `DASHBOARD_URL`: deployed HTTPS origin; required, no localhost fallback.
* `DASHBOARD_USER`: existing username variable; defaults to `admin`, as smoke does.
* `DASHBOARD_PASSWORD`: parent injects this into the process environment.
  The tests never fetch secrets or write auth storage state.
* `DASHBOARD_RESEARCHER_LIVE=1`: explicit authorization to execute live tests.
* `DASHBOARD_PROJECT_ID`: optional existing, provisioned project. The identity
  needs actual researcher/project-admin membership, including admin accounts.
* `DASHBOARD_E2E_CPU_IMAGE`: optional Python stdlib image; default
  `public.ecr.aws/docker/library/python:3.12-slim`. No NumPy, recipe adapters,
  model downloads, GPU, or credential references are required.
  With `IMAGE_PROFILES_ENFORCED=1`, set this to an approved private-ECR mirror;
  the public default is intentionally not allowed by that policy. The CPU
  fixture requests 1 CPU / 1 GiB, matching the profile's default minimum.
* `DASHBOARD_E2E_CPU_PLATFORM`: optional provisioned CPU node platform selector.
  The tests do not assume a particular instance type.

With the parent-injected auth environment, the exact live command from
`dashboard/web` is:

```sh
DASHBOARD_RESEARCHER_LIVE=1 npx --no-install playwright test e2e/researcher.spec.ts --workers=1 --retries=0 --output=e2e/.results/researcher
```

Safe local validation, without reading password values, launching a browser,
authenticating, submitting work, or contacting AWS:

```sh
npx --no-install tsc -p e2e/tsconfig.researcher.json
npx --no-install playwright test e2e/researcher.spec.ts --list
```

## Assertions

1. Modified `custom` recipe: real Python writes `artifact/proof.json`, then exits
   **7** with `exitActions.COMPLETE=7`. Require workflow/task `SUCCEEDED`, raw
   exit 7, wrapper exit 0, a matching artifact receipt and READY dataset version.
   Download the published proof and check the current run ID, nonce and values.
2. Dataset: create a PENDING version, upload exact `records.json` bytes, request
   `refresh-size` finalization, require READY with verified manifest/size, then
   submit a consumer with the explicit numeric version. Its Python process
   checks the actual hydrated file digest and `.pai-input-receipt.json` hash.
   Its own published proof must agree with the pinned workflow snapshot.
3. Sessions: start one owned, bounded CPU task. Require `pai-files` on the ready
   replica, READY/canOpen terminal and file sessions, valid HTTPS navigation,
   ticket removal, connected xterm UI, real browser upload and file download.
   Execute a fixed Python file write through the authenticated terminal protocol
   and read those exact bytes through the separate file session.

The current completion API status is `SUCCEEDED`; `COMPLETE` is the exit action,
not an invented workflow status. Dataset finalization is
`POST /api/datasets/<name>/versions/<v> {"action":"refresh-size"}`.
There is no GET session-by-ID route: readiness is read from `/api/sessions`.

## Budgets, evidence and cleanup

Each test has a 30-minute ceiling. API calls: 30s; login: bounded navigation/
form waits up to 90s; workflow completion: 12m; running-task readiness: 8m;
dataset finalization: 5m; session readiness: 2m; launch: 45s; transfer/terminal
proof: 60s; cleanup: 3m. The long task also has its own 20-minute maximum.
Transient pending states poll; HTTP errors and unsupported services fail visibly.
No auto-retries hide duplicate work.

Run IDs and session IDs are printed as they are created. Every fixture attaches
`researcher-resources` JSON with recorded creation intents, IDs, state changes
and cleanup results. Launch tickets, signed URLs, passwords and cookie values
are not attached. Automatic screenshots, traces and videos are disabled for
this suite to avoid retaining those credentials.

Cleanup operates only on exact recorded IDs after verifying ownership/project.
It closes attached sessions, confirms old gateway grants are rejected, cancels
unfinished test runs and waits for terminal workflow/task states. Cleanup
failure fails the test and lists the affected IDs; it is never swallowed.

Completed runs, READY datasets and small proof artifacts remain as inspection
evidence. No S3 purge, history deletion or unrelated-resource cleanup is done.
If a creation response is lost, its unique workflow name/idempotency intent is
recorded and cleanup reports the unresolved creation rather than guessing at
resources to delete. The parent can use these records for explicit follow-up.

The source directory remains unmodified by validation. Live output is directed
under `e2e/.results/researcher`; keep those reports local and out of commits.

Authoring validation completed locally: scoped TypeScript check, discovery of
all three tests, parsing all generated workflows with the current YAML/schema
parser, and Python syntax plus producer/consumer payload checks using temporary
local files. These checks did not authenticate or run live integration tests.

## Second-release F09 test

`checkpoint-recovery.spec.ts` is separate from the first-release suite. It
requires an updated MuJoCo recipe image in `DASHBOARD_E2E_MUJOCO_IMAGE` and an
additional explicit deployment gate. It performs real training in attempt 1,
exits 75, and requires automatic attempt 2 to prove restored optimizer tensors
and normalization state before advancing training and publishing READY proof.

After second-release deployment confirmation, with the parent-injected auth
and image environment:

```sh
DASHBOARD_RESEARCHER_LIVE=1 DASHBOARD_CHECKPOINT_RECOVERY_LIVE=1 npx --no-install playwright test e2e/checkpoint-recovery.spec.ts --workers=1 --retries=0 --output=e2e/.results/checkpoint-recovery
```

This test has been authored for the second release; it has not been run remotely.
