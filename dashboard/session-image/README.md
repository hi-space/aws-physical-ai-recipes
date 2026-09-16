# Managed research workspace image

Build this trusted image and set `WORKSPACE_IMAGE_URI` in the dashboard API and
controller processes. Also set `TASK_RUNTIME_IMAGE` to the updated trusted runtime
image containing `--verify-isolation`; both images are persisted in each new
managed session record. The session service creates suspended Kueue Jobs in an
existing project namespace/LocalQueue; it creates no Deployment or Service.

Pinned application releases (verified from official registries on 2026-09-16):

| Application | Version | Build source |
| --- | --- | --- |
| JupyterLab | 4.6.3 | Official PyPI `jupyterlab` project |
| TensorBoard | 2.21.0 | Official PyPI `tensorboard` project |
| code-server | 4.137.0 | `coder/code-server` GitHub release; amd64/arm64 archive SHA-256 verified |
| Python base | 3.12, Debian bookworm slim | Multi-platform image digest pinned in Dockerfile |

Python application versions are pinned directly; transitive Python dependencies
are resolved during build. Publish the resulting image under an immutable digest
for deployment. No package installation is performed by the app launcher or Job.

From this directory:

```sh
docker build -t physical-ai-session-local:20260916 .
docker run --rm --user 0 --network none --entrypoint python \
  -v "$PWD:/tests:ro" -w /tests physical-ai-session-local:20260916 \
  -m unittest -v test_session_image
```

The default command is `jupyter`; alternatives are `tensorboard` and `code-server`.
`session.py` launches the actual app, binds only to `127.0.0.1`, and uses fixed
ports 8888, 6006 and 8080 respectively. Gateway Kubernetes port-forward reaches
that loopback listener. No app password/token is needed because the isolated-host
gateway performs authentication; Jupyter's normal XSRF checks remain enabled.
The exec readiness probe runs `python /opt/pai/session.py --ready <kind>`.

The app runs as UID/GID 1000 with a read-only root filesystem, all capabilities
dropped, no privilege escalation, and a writable ephemeral `/tmp`. Only its exact
`sessions/projects/<project>/<session>` FSx leaf is writable as `/workspace`.
TensorBoard receives a separate read-only `/logs` subPath inside the authorized
project's checkpoint or dataset tree. Other sessions' workspaces and the full
FSx volume are never mounted in the app. Ending a session retains workspace data.

Only the fixed `prepare.py` init container sees the full PVC. It receives validated
project/session IDs and an optional scoped log path, never user commands or code.
It walks directories using directory file descriptors and `O_NOFOLLOW`, rejects
untrusted writable ancestors and symlinks, creates root-owned ancestors and a
session-owned 0700 leaf, and never recursively changes existing user content.
The initializer requires the root identity and CHOWN/FOWNER/DAC_OVERRIDE caps;
parent admission policy must permit this specific trusted initializer.

The existing project resources must include:

- `fsx-pvc`, the server-selected Kueue LocalQueue, and the project namespace;
- an unprivileged `pai-workload` service account (or `WORKSPACE_SERVICE_ACCOUNT`)
  with **no IRSA role and no EKS Pod Identity association**;
- enforced network policy and node metadata protections. The service installs
  `pai-sessions` NetworkPolicy, denying Pod ingress and excluding link-local
  metadata destinations from egress. NetworkPolicy rules are additive: the parent
  must ensure other policies do not reopen metadata access and the CNI actually
  enforces these rules. Cluster networking is not modified by this implementation
  session and was not validated against AWS.

`automountServiceAccountToken` is false, service link injection is disabled, and
no controller/runtime AWS credentials are supplied. `session.py` refuses known
AWS identity/credential environment injection before starting an app and removes
remaining AWS/runtime environment entries, keeping metadata lookup disabled.

Local verification included building the image, all seven Python safety tests,
and starting all three apps as non-root with read-only filesystems and dropped
capabilities. Each returned HTTP 200 on loopback and refused connections to its
container IP. These tests do not establish live EKS CNI/FSx/admission behavior.

After storage preparation, a separate non-root init container runs
`/opt/pai/runtime --verify-isolation` from TASK_RUNTIME_IMAGE. It receives no
broker token, contract, credentials, environment entries, or volume mounts.
Its startup TCP connectivity check must succeed before the app starts; it changes
no network policy. Continuous isolation remains the parent's enforced policy.
