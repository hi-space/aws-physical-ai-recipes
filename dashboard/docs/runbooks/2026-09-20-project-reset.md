# Runbook — reset projects to the ComputeQuota-adoption model (2026-09-20)

Applies once, when deploying the "project = HyperPod team" change to an environment that still has the
legacy `workshop` project (namespace `hyperpod-ns-team-a`). Executed against the production account on
2026-09-20; the "as run" notes record what was actually found.

## 0. Inventory the legacy footprint first

```bash
TABLE=physical-ai-dashboard-<account>-<region>
aws dynamodb scan --table-name "$TABLE" --projection-expression "pk, sk, projectId, #ns" --expression-attribute-names '{"#ns":"namespace"}' \
  --output json > /tmp/ddb-all.json
jq -r '.Items[] | .pk.S | sub("#.*";"")' /tmp/ddb-all.json | sort | uniq -c | sort -rn      # item kinds
jq -r '.Items[] | select(.projectId) | .projectId.S' /tmp/ddb-all.json | sort | uniq -c      # projectId values
jq -r '.Items[] | select(.pk.S|startswith("PROJECT")) | select(.pk.S|startswith("PROJECT#workshop")|not) | "\(.pk.S) / \(.sk.S)"' /tmp/ddb-all.json
aws cognito-idp list-groups --user-pool-id <pool> --query 'Groups[].GroupName'               # expect no proj-* yet
aws sagemaker list-compute-quotas --query 'ComputeQuotaSummaries[].{id:ComputeQuotaId,team:ComputeQuotaTarget.TeamName}'
```

As run (2026-09-20, table `physical-ai-dashboard-913524902871-us-east-1`, 14 948 items):

| Kind | Found | Decision |
|---|---|---|
| `PROJECT#workshop / META` (with `members` map, stored `namespace`/`queue`) | 1 | delete |
| `PROJECT_NAMESPACE#hyperpod-ns-team-a / OWNER` | 1 (the `default#`-prefixed variant did **not** exist) | delete |
| `PROJECT#workshop` configuration: `IMAGE_PROFILE#` 10, `IMAGE_PROFILE_REV#` 61, `TOKEN#` 5, `WEBHOOK#` 2 + `WEBHOOK_REGISTRY`, `SOURCE#` 2, `CREDENTIAL#` 1 | 82 | delete (backed up) |
| `API_TOKEN#… / META` bound to `workshop`, `CREDENTIAL_REF#… / PROJECT#workshop`, `WEBHOOK#workshop#… / DELIVERY#…` 2 | 4 | delete (backed up) |
| `SESS#… ns=hyperpod-ns-workshop` (created by a local `next dev` against the live table before the reset) | 1 | delete |
| `PROJECT#workshop / PIPELINE#` 4, `PIPELINE_ARCHIVE#` 2, `EVALUATION#workshop#` 2, `TRACKING#workshop` 4, `SOURCE_BUILD#` 1 | 13 | keep (run history) |
| `WF#`/`DS#`/`TPL#`/`SESS#`/`MODEL#`/`PUB#`/`LOG#` items with `projectId: workshop` | 699 (+ logs) | keep — visible to platform admins only |
| `WF#` with `namespace: rl` and no `projectId` (pre-project runs, 2026-09-16) | 4 | keep (history) |
| Cognito `proj-*` groups | 0 | nothing to clean |
| K8s namespace `rl` | does not exist | drop its Pod Identity association (CDK default list) |
| S3 `hyperpod-eks-data-…/checkpoints/projects/workshop/` | 6 694 objects, 147 GB | keep (published outputs); delete manually if the history is no longer needed |
| FSx `projects/workshop/…` | not inspected from the operator host | same as S3 |
| ECR `physical-ai/projects/workshop/source-images` (3 images, ~21 GB incl. two `*-verify` images) + CodeBuild `physical-ai-source-workshop-…` + its log group | CDK-provisioned for `workshop` | renamed to `team-a` by the deploy below; the old ECR repo and log group are RETAINed and can be deleted by hand |

## 1. Before deploying

1. Confirm no RUNNING/FINALIZING workflows or OPEN sessions (dashboard › Runs, Sessions, or a filtered scan on `status`).
2. **Do not delete anything yet.** The deployed pre-reset code still has `ensureDefaultProject`, which re-creates
   `PROJECT#workshop` on the next admin request. Deletion only sticks after the new code is live.
3. Back up + preview the deletion set (dry run, no writes):
   ```bash
   dashboard/infra/ops/legacy-project-reset.sh --table "$TABLE" --project workshop --namespace hyperpod-ns-team-a \
     --backup-dir ~/backups/pai-project-reset-workshop-$(date -u +%Y%m%d)
   ```

## 2. Deploy

```bash
cd dashboard/infra && npx cdk diff  <same context as deploy>   # expect: 3 task definitions, IAM (cognito-idp Create/Delete/GetGroup),
                                                                 # ResearcherSourceBuild ECR/LogGroup/CodeBuild rename, PodIdentity-rl destroy
npx cdk deploy -c domainName=… -c hostedZoneId=… -c hostedZoneName=… -c adminEmail=… -c extendedImages=true \
  -c sourceBuildProjectId=team-a -c 'optionalImages={…same as the previous deploy…}' --require-approval never
```

`sourceBuildProjectId` is new and required while `sourceBuild=true`: the CodeBuild/ECR source-build target is named after the
adopted team. Keep passing the same `optionalImages` JSON as the previous deploy or the optional workload images are deleted.

## 3. Remove the legacy records

```bash
dashboard/infra/ops/legacy-project-reset.sh --table "$TABLE" --project workshop --namespace hyperpod-ns-team-a \
  --backup-dir ~/backups/pai-project-reset-workshop-$(date -u +%Y%m%d) --apply
# the stray dev session (find it with: jq -r '.Items[] | select(.namespace.S=="hyperpod-ns-workshop") | .pk.S' /tmp/ddb-all.json)
aws dynamodb delete-item --table-name "$TABLE" --key '{"pk":{"S":"SESS#<id>"},"sk":{"S":"META"}}'
```

Restore any item from the backup with `jq -c '.[N]' items.json > item.json && aws dynamodb put-item --table-name "$TABLE" --item file://item.json`.

## 4. Adopt the team

4. Sign in as a platform admin → Projects → *Adopt a team* → backend `default` → pick the `team-a` ComputeQuota → Adopt
   (API: `POST /api/projects {"computeQuotaId":"<ComputeQuotaId>"}`). This creates Cognito groups `proj-team-a` and `proj-team-a-admin`.
5. Image profiles are per project, so the new project has none: Images → *Seed built-in profiles* (`POST /api/image-profiles/seed`
   with an empty JSON body `{}`, header `x-pai-project: team-a`), then approve each `builtin-*` candidate
   (`POST /api/image-profiles {id,name,image,expectedVersion:<candidate version>,requirements}`; the legacy project had used the
   default requirements — 1 CPU / 1024 MiB / no GPU / any platform — for all eight). Until this is done every submission fails
   preflight with `image_preflight_blocked`. As run: eight `builtin-*` profiles approved at v2 for `team-a` on 2026-09-20.
6. Projects → `team-a` → add each researcher by Cognito username (role *Member*; team leads *Project admin*). Platform admins
   need no group (they are project-admin everywhere).
7. Ask users to sign out and back in (or wait for the access-token refresh) so `proj-team-a` appears in their session.

## 5. Verify

8. `/api/projects` shows `team-a` with `attachment: ATTACHED`, `namespace: hyperpod-ns-team-a`, `queue: hyperpod-ns-team-a-localqueue`.
9. `/api/image-profiles` (project `team-a`) lists approved `builtin-*` profiles; a researcher can submit a workflow and Queues shows it
   under `hyperpod-ns-team-a-localqueue`.
10. Cognito: `proj-team-a`, `proj-team-a-admin` exist; DynamoDB: `PROJECT#team-a / META`, `PROJECT_NAMESPACE#hyperpod-ns-team-a / OWNER`,
    `PROJECT_QUOTA#<id> / OWNER` all point at `team-a`.

## 6. Optional manual cleanup (not done by the reset)

```bash
# old source-build repository retained by CloudFormation (verify images are rebuildable)
aws ecr delete-repository --repository-name physical-ai/projects/workshop/source-images --force
aws logs delete-log-group --log-group-name /aws/codebuild/physical-ai-source-workshop-<account>
# workshop run outputs (147 GB as of 2026-09-20) — only if the run history is no longer needed
aws s3 rm s3://hyperpod-eks-data-<account>-<region>/checkpoints/projects/workshop/ --recursive
```
