# Physical AI CLI

Python **3.11+**, standard library only. Secure local file handling requires POSIX `O_NOFOLLOW` and directory-descriptor support. There is no installation step and no AWS CLI credential dependency.

Create a project-bound API token at the dashboard's `/access` page, then run:

```bash
python3 dashboard/cli/pai.py login --url https://physical-ai.example.com
python3 dashboard/cli/pai.py workflows list
python3 dashboard/cli/pai.py workflows submit recipe.yaml --param seed=7 --idempotency-key experiment-20260916-01
python3 dashboard/cli/pai.py workflows status RUN_ID
python3 dashboard/cli/pai.py workflows cancel RUN_ID
python3 dashboard/cli/pai.py workflows logs RUN_ID --task train --follow
```

`login` uses a hidden `getpass` prompt. Tokens are never accepted as command-line arguments. The default config is `${XDG_CONFIG_HOME:-~/.config}/physical-ai/credentials.json`; its directory is private and the file is written atomically with mode 0600. An alternate path goes before the subcommand: `pai.py --config /private/directory/credentials.json login --url ...`.

Login saves nothing until `/api/v1/me` confirms `authMethod: "token"`, a viewer/researcher role and `tokenProjectId`. Missing middleware, missing versioned API, login redirects, malformed responses and insufficient scopes fail visibly. Parent integration owns the ALB exception, token verification/rewrite, forced project binding and token-specific CSRF handling.

All dashboard requests use `/api/v1`. Workflow commands use the project workflow API; direct global/legacy SageMaker and MLflow management APIs are not implicitly token-enabled. A read-only token can list/status/log; submission and cancellation require `workflows:write`. Supply the same explicit `--idempotency-key` when retrying an ambiguous submission. The default is a fresh key per CLI invocation.

When image-profile enforcement requires preflight review, inspect the same workflow and parameter values in the dashboard's YAML/submit screen. After reviewing the image/runtime findings, explicitly add `--acknowledge-preflight` to `workflows submit`; it sends `acknowledgePreflight: true`. The CLI never adds consent or retries automatically after HTTP 428. This flag cannot override blocked findings (HTTP 422).

## Runtime file synchronization

```bash
python3 dashboard/cli/pai.py sync upload --workflow RUN_ID --task train --local ./results
python3 dashboard/cli/pai.py sync download --workflow RUN_ID --task train --local ./downloads --path videos
python3 dashboard/cli/pai.py sync watch --workflow RUN_ID --task train --local ./configs --interval 2
```

Sync requires `sessions:read` and `sessions:write`. It creates its own `port-forward` session with `portName: "pai-files"`, verifies its project/workflow/task binding and owner `canEnd` capability, and polls the own-session list until READY and `canOpen`. It then exchanges a one-use launch ticket into an in-memory host-only `__Host-pai-session` cookie. The expected gateway is `<session-id>.apps.<dashboard-host>` over HTTPS. Other domains, domain cookies, redirects to other hosts, or missing runtime file APIs are rejected.

The **dashboard bearer is never sent to the gateway or S3**. Gateway PUTs use the session cookie and gateway Origin. Session cleanup targets only the newly created, validated session. A cleanup failure remains an error. Sessions have a 60-minute requested lifetime; watch does not silently extend them. Expiry/revocation closes file access, and the user can start another sync session if still authorized. No AWS mutation is performed during implementation/tests; actual CLI use submits the explicit API operations above.

The runtime file protocol is:

- `GET /api/files?path=<relative-directory>` → `{path, entries:[{name,path,type,size,modifiedAt}], maxUploadBytes}`.
- `GET /files/<relative-file>` → streamed download.
- `PUT /files/<relative-file>` → raw upload, **204** after server commit.

The parent must register the task's `pai-files` port (8077) and provide authenticated gateway port forwarding. The runtime root is the task output directory. File service exists only while the workload is active; archived artifacts use separate APIs.

Default exclusions: `.git`, `node_modules`, `.env*`, `.aws`, `.ssh`, runtime `.pai-*`/`pai-checkpoint-*`, and the CLI's own credentials file/directory. Symlinks, hard-linked files and special files are not transferred. Unsafe remote paths fail rather than escaping the local root. Local downloads are staged and atomically renamed only after the listed byte count matches. Watch compares content hashes; deleting a local file **never deletes a remote file**. There is no remote delete or ranged/resumable transfer API. Interrupted transfers must be retried.

The CLI does not print request/launch URLs or credentials. Job log content preserves repeated/blank lines and ordinary URLs; capture redacts exact approved task secrets, and the CLI also redacts its exact API token across chunk boundaries. `logs --follow` replays committed archive records using an opaque cursor, with current token/project authorization on every request. Capture gaps are reported separately on stderr; Kubernetes rotation or disconnected source bytes may be missing.

Use `--start beginning` for all retained captured bytes, or the default bounded `--start tail` for recent bytes. Select `--attempt`, `--member`, `--container`, or an exact archive `--stream`. `--cursor-file /private/directory/log-cursor.json` saves a private resume position after clean completion or Ctrl-C and output flush; it is bound to the command, project and token. An abrupt process crash may replay the last invocation because stdout and the checkpoint cannot be committed atomically. Cursors expire after one hour; retained archives expire after 30 days. An expired cursor is an error and does not silently jump to another source. The old `--tail` line-count option is replaced by these archive selectors.

## Tests

```bash
python3 -B -m unittest discover -s dashboard/cli/tests -v
```

Tests use fake transports and temporary local files. They do not access AWS or real network services.
