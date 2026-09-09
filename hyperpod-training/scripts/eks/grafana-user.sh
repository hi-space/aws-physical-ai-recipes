#!/usr/bin/env bash
# =============================================================================
# grafana-user.sh — IAM Identity Center 사용자에게 HyperPod Grafana 워크스페이스 ADMIN 권한 부여 (모듈 8B)
#
# 사용법:
#   ./scripts/eks/grafana-user.sh <identity-center-username> [--role ADMIN|EDITOR|VIEWER] [--region <region>]
#
# Amazon Managed Grafana 는 IAM 자격증명이 아니라 IAM Identity Center 사용자로 로그인한다. CDK 가 만든
# 워크스페이스(HyperPodEks-<ACCOUNT_ID>)에는 아직 아무 사용자도 없으므로, 본인 Identity Center 사용자를
# 여기서 한 번 할당한 뒤 스택 Output GrafanaUrl 로 로그인한다.
# =============================================================================
set -euo pipefail

WORKSHOP_REGION="${REGION:-}"
USERNAME="${1:-}"
shift || true
ROLE="ADMIN"
REGION=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --role) ROLE="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    *) echo "알 수 없는 옵션: $1" >&2; exit 1 ;;
  esac
done
if [[ -z "$USERNAME" ]]; then
  echo "사용법: $0 <identity-center-username> [--role ADMIN|EDITOR|VIEWER] [--region <region>]" >&2
  exit 1
fi
if [[ -z "$REGION" ]]; then
  REGION="${WORKSHOP_REGION:-${AWS_REGION:-${AWS_DEFAULT_REGION:-$(aws configure get region 2>/dev/null || echo us-east-1)}}}"
fi
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
STACK="${STACK_NAME:-HyperPodEks-${ACCOUNT_ID}}"

WORKSPACE_ID="$(aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='GrafanaWorkspaceId'].OutputValue" --output text)"
GRAFANA_URL="$(aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='GrafanaUrl'].OutputValue" --output text)"
[[ -n "$WORKSPACE_ID" && "$WORKSPACE_ID" != "None" ]] || { echo "스택 ${STACK} 에 GrafanaWorkspaceId Output 이 없습니다 (enableObservability=false?)." >&2; exit 1; }

# Identity Center 인스턴스는 계정당 하나이며 리전이 다를 수 있다(홈 리전). 모든 리전을 뒤지지 않고
# sso-admin 이 어디에 있든 list-instances 는 글로벌 결과를 돌려준다.
IDSTORE="$(aws sso-admin list-instances --region "$REGION" --query "Instances[0].IdentityStoreId" --output text 2>/dev/null || true)"
IDC_REGION="$REGION"
if [[ -z "$IDSTORE" || "$IDSTORE" == "None" ]]; then
  for r in us-east-1 us-west-2 ap-northeast-2 ap-northeast-1 eu-west-1; do
    IDSTORE="$(aws sso-admin list-instances --region "$r" --query "Instances[0].IdentityStoreId" --output text 2>/dev/null || true)"
    if [[ -n "$IDSTORE" && "$IDSTORE" != "None" ]]; then IDC_REGION="$r"; break; fi
  done
fi
[[ -n "$IDSTORE" && "$IDSTORE" != "None" ]] || { echo "IAM Identity Center 인스턴스를 찾지 못했습니다. 콘솔에서 Identity Center 를 활성화하고 사용자를 만드세요." >&2; exit 1; }

USER_ID="$(aws identitystore list-users --identity-store-id "$IDSTORE" --region "$IDC_REGION" \
  --filters "AttributePath=UserName,AttributeValue=${USERNAME}" --query "Users[0].UserId" --output text)"
[[ -n "$USER_ID" && "$USER_ID" != "None" ]] || { echo "Identity Center 사용자 '${USERNAME}' 을 찾지 못했습니다 (store ${IDSTORE}, ${IDC_REGION})." >&2; exit 1; }

aws grafana update-permissions --workspace-id "$WORKSPACE_ID" --region "$REGION" \
  --update-instruction-batch "[{\"action\":\"ADD\",\"role\":\"${ROLE}\",\"users\":[{\"id\":\"${USER_ID}\",\"type\":\"SSO_USER\"}]}]" >/dev/null

echo "Grafana 워크스페이스 ${WORKSPACE_ID}: ${USERNAME} → ${ROLE}"
echo "로그인: ${GRAFANA_URL}"
