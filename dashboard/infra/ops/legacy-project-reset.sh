#!/usr/bin/env bash
# One-time cleanup of a legacy (pre-adoption) dashboard project in DynamoDB.
#
#   legacy-project-reset.sh --table <table> --project workshop --namespace hyperpod-ns-team-a [--backend default]
#                           [--backup-dir <dir>] [--apply]
#
# Without --apply the script only backs up and prints what it WOULD delete.
#
# What it deletes (project *configuration* of the removed project):
#   PROJECT#<id>/META, IMAGE_PROFILE#*, IMAGE_PROFILE_REV#*, SOURCE#*, TOKEN#*, WEBHOOK#*, WEBHOOK_REGISTRY, CREDENTIAL#*
#   PROJECT_NAMESPACE#<ns>/OWNER and PROJECT_NAMESPACE#<backend>#<ns>/OWNER, PROJECT_QUOTA#*/OWNER owned by <id>
#   API_TOKEN#*/META bound to <id>, CREDENTIAL_REF#*/PROJECT#<id>, WEBHOOK#<id>#*/DELIVERY#*
# What it keeps (run history, still readable by platform admins): PIPELINE*, EVALUATION#, TRACKING#, SOURCE_BUILD#,
#   and every WF#/DS#/TPL#/SESS#/MODEL#/PUB#/LOG# item that merely carries projectId=<id>.
#
# Every item in the PROJECT#<id> partition plus every related item above is written to <backup-dir>/items.json
# (DynamoDB JSON) before anything is deleted. Restore one item with:
#   jq -c '.[N]' items.json | xargs -0 aws dynamodb put-item --table-name <table> --item
# Requires: aws cli v2, jq.
set -euo pipefail

TABLE="${TABLE_NAME:-}" PROJECT="" NAMESPACE="" BACKEND="default" APPLY=0 BACKUP_DIR="" REGION="${AWS_REGION:-us-east-1}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --table) TABLE="$2"; shift 2 ;;
    --project) PROJECT="$2"; shift 2 ;;
    --namespace) NAMESPACE="$2"; shift 2 ;;
    --backend) BACKEND="$2"; shift 2 ;;
    --backup-dir) BACKUP_DIR="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --apply) APPLY=1; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$TABLE" && -n "$PROJECT" && -n "$NAMESPACE" ]] || { echo "--table, --project and --namespace are required" >&2; exit 2; }
[[ "$PROJECT" =~ ^[a-z][a-z0-9-]{0,39}$ ]] || { echo "invalid project id" >&2; exit 2; }
command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }
BACKUP_DIR="${BACKUP_DIR:-$HOME/backups/pai-project-reset-$PROJECT-$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$BACKUP_DIR"
ddb() { aws dynamodb "$@" --region "$REGION" --output json; }

echo "== collecting items for project '$PROJECT' (namespace $NAMESPACE, backend $BACKEND) from $TABLE"
partition=$(ddb query --table-name "$TABLE" --key-condition-expression "pk = :pk" \
  --expression-attribute-values "{\":pk\":{\"S\":\"PROJECT#$PROJECT\"}}" | jq -c '.Items')
owners=$(ddb batch-get-item --request-items "{\"$TABLE\":{\"Keys\":[
  {\"pk\":{\"S\":\"PROJECT_NAMESPACE#$NAMESPACE\"},\"sk\":{\"S\":\"OWNER\"}},
  {\"pk\":{\"S\":\"PROJECT_NAMESPACE#$BACKEND#$NAMESPACE\"},\"sk\":{\"S\":\"OWNER\"}}]}}" | jq -c ".Responses[\"$TABLE\"]")
# Related top-level items are found with one filtered scan (the table is small; this runs once).
related=$(ddb scan --table-name "$TABLE" \
  --filter-expression "(begins_with(pk, :q) AND projectId = :p) OR (begins_with(pk, :t) AND projectId = :p) OR (begins_with(pk, :c) AND sk = :csk) OR begins_with(pk, :w)" \
  --expression-attribute-values "{\":q\":{\"S\":\"PROJECT_QUOTA#\"},\":t\":{\"S\":\"API_TOKEN#\"},\":c\":{\"S\":\"CREDENTIAL_REF#\"},\":csk\":{\"S\":\"PROJECT#$PROJECT\"},\":w\":{\"S\":\"WEBHOOK#$PROJECT#\"},\":p\":{\"S\":\"$PROJECT\"}}" | jq -c '.Items')
all=$(jq -c -n --argjson a "$partition" --argjson b "$owners" --argjson c "$related" '$a + $b + $c')
echo "$all" | jq '.' > "$BACKUP_DIR/items.json"
echo "backed up $(echo "$all" | jq 'length') items to $BACKUP_DIR/items.json"

# Deletion set: configuration records only.
delete=$(echo "$all" | jq -c --arg p "$PROJECT" '[ .[] | select(
    (.pk.S == ("PROJECT#" + $p) and (.sk.S == "META" or .sk.S == "WEBHOOK_REGISTRY"
      or (.sk.S | test("^(IMAGE_PROFILE#|IMAGE_PROFILE_REV#|SOURCE#|TOKEN#|WEBHOOK#|CREDENTIAL#)"))))
    or (.pk.S | startswith("PROJECT_NAMESPACE#")) or (.pk.S | startswith("PROJECT_QUOTA#"))
    or (.pk.S | startswith("API_TOKEN#")) or (.pk.S | startswith("CREDENTIAL_REF#")) or (.pk.S | startswith("WEBHOOK#" + $p + "#"))
  ) | {pk: .pk, sk: .sk} ]')
keep=$(echo "$all" | jq -c --argjson d "$delete" '[ .[] | {pk: .pk, sk: .sk} ] - $d')
summarize() { jq -r '.[] | "  \(.pk.S | sub("#(?<x>.*)$"; "#…")) / \(.sk.S | sub("#.*$"; "#…"))"' | sort | uniq -c | sort -rn; }
echo "== would delete $(echo "$delete" | jq 'length') items (count  pk-kind / sk-kind):"
echo "$delete" | summarize
echo "== keeps $(echo "$keep" | jq 'length') history items in the partition/related set:"
echo "$keep" | summarize
echo "$delete" | jq '.' > "$BACKUP_DIR/deleted-keys.json"

if [[ $APPLY -ne 1 ]]; then echo "== dry run (pass --apply to delete)"; exit 0; fi
echo "== deleting"
n=0
while read -r key; do
  aws dynamodb delete-item --table-name "$TABLE" --region "$REGION" --key "$key" >/dev/null
  n=$((n + 1))
done < <(echo "$delete" | jq -c '.[]')
echo "deleted $n items; backup at $BACKUP_DIR"
