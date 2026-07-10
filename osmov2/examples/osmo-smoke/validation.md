# OSMO Smoke Validation

This file records validation for [workflow.yaml](workflow.yaml).

## 2026-04-28 CPU Smoke After UI Extension

Status: Passed

Command:

```bash
scripts/smoke-test.sh
```

Observed result:

- Workflow: `aws-osmo-smoke-1`
- OSMO data access validation passed against the AWS S3-backed workflow storage.
- The backend operator executed the workflow in `osmo-workflows`.
- Workflow log included `hello from AWS OSMO smoke workflow`.
- Workflow completed successfully.

## 2026-04-29 KAI Scheduler Smoke

Status: Passed

Commands:

```bash
scripts/deploy-osmo.sh
scripts/deploy-kai.sh
scripts/validate-platform.sh
scripts/smoke-test.sh
scripts/validate-platform.sh
```

Observed result:

- Workflow: `aws-osmo-smoke-9`
- OSMO data access validation passed.
- Workflow log included `hello from AWS OSMO smoke workflow`.
- KAI scheduler log showed `There are <1> PodGroupInfos`.
- KAI created a bind request for the workflow task.
- The `osmo-workflows` namespace had no remaining pods or PodGroups after completion.

Notes:

- The 2026-04-29 run validates the same smoke workflow with KAI as the Kubernetes scheduler.
