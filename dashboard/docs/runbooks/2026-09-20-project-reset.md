# Runbook — reset projects to the ComputeQuota-adoption model (2026-09-20)

Applies once, when deploying the "project = HyperPod team" change to an environment that still has the
legacy `workshop` project (namespace `hyperpod-ns-team-a`).

## Before deploying
1. Confirm no RUNNING workflows or open sessions: dashboard › Runs, Sessions.
2. Note the table name: `aws cloudformation describe-stacks --stack-name <dashboard-stack> --query "Stacks[0].Outputs"` (or `/api/me` → `resources.table`).

## Deploy
3. `cd dashboard/infra && npx cdk deploy` (adds Cognito CreateGroup/DeleteGroup/GetGroup to the web task role).

## Remove the legacy records
```bash
TABLE=<table-name>
aws dynamodb delete-item --table-name "$TABLE" --key '{"pk":{"S":"PROJECT#workshop"},"sk":{"S":"META"}}'
aws dynamodb delete-item --table-name "$TABLE" --key '{"pk":{"S":"PROJECT_NAMESPACE#hyperpod-ns-team-a"},"sk":{"S":"OWNER"}}'
aws dynamodb delete-item --table-name "$TABLE" --key '{"pk":{"S":"PROJECT_NAMESPACE#default#hyperpod-ns-team-a"},"sk":{"S":"OWNER"}}'
```
Workflows/datasets/templates that carry `projectId: workshop` stay in the table and remain visible to platform admins only. S3/FSx prefixes `projects/workshop/…` are not moved.

## Adopt the team
4. Sign in as a platform admin → Projects → *Adopt a team* → backend `default` → pick the `team-a` ComputeQuota → Adopt.
5. Projects → `team-a` → add each researcher by Cognito username (role *Member*; team leads *Project admin*).
6. Ask users to sign out and back in (or wait for the access-token refresh) so `proj-team-a` appears in their session.

## Verify
7. `/api/projects` shows `team-a` with `attachment: ATTACHED`.
8. A researcher can submit a workflow; Queues shows it under `hyperpod-ns-team-a-localqueue`.
