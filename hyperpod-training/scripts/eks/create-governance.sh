#!/usr/bin/env bash
# =============================================================================
# create-governance.sh — HyperPod task governance 정책 생성 (모듈 9C §9C.2)
#
#   cluster policy  (ClusterSchedulerConfig) : 우선순위 클래스 training/inference/background + FairShare
#   compute quota   (ComputeQuota) x2        : team-a = ml.g5.8xlarge 1대, team-b = ml.c5.4xlarge 1대
#
# 정책은 CloudFormation 리소스 타입이 없어 AWS CLI 로 만든다. compute quota 가 생기면 task governance 애드온이
# 네임스페이스 hyperpod-ns-<team>, LocalQueue hyperpod-ns-<team>-localqueue, ClusterQueue 를 자동 생성한다.
#
# 사용법:
#   ./scripts/eks/create-governance.sh [--region <region>] [--cluster <hyperpod-cluster-name>]
# 입력 JSON: k8s-templates/governance/{cluster-policy,compute-quota-team-a,compute-quota-team-b}.json
# =============================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GOV_DIR="${HERE}/../../k8s-templates/governance"
WORKSHOP_REGION="${REGION:-}"
REGION=""
CLUSTER_NAME=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --region) REGION="$2"; shift 2 ;;
    --cluster) CLUSTER_NAME="$2"; shift 2 ;;
    *) echo "알 수 없는 옵션: $1" >&2; exit 1 ;;
  esac
done
if [[ -z "$REGION" ]]; then
  REGION="${WORKSHOP_REGION:-${AWS_REGION:-${AWS_DEFAULT_REGION:-$(aws configure get region 2>/dev/null || echo us-east-1)}}}"
fi
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
[[ -n "$CLUSTER_NAME" ]] || CLUSTER_NAME="hyperpod-eks-${ACCOUNT_ID}"
CLUSTER_ARN="$(aws sagemaker describe-cluster --cluster-name "$CLUSTER_NAME" --region "$REGION" --query ClusterArn --output text)"
echo "클러스터: ${CLUSTER_NAME} (${REGION})"

wait_status() { # <describe-cmd...> — Status 가 Created 가 될 때까지 대기
  for _ in $(seq 1 60); do
    STATUS="$("$@" --query Status --output text 2>/dev/null || echo Pending)"
    case "$STATUS" in
      Created) return 0 ;;
      CreateFailed|Failed) echo "  실패: $("$@" --query FailureReason --output text)" >&2; return 1 ;;
    esac
    sleep 5
  done
  echo "  시간 초과 (마지막 상태: ${STATUS})" >&2; return 1
}

# 1) cluster policy — 클러스터당 하나만 존재할 수 있다.
EXISTING="$(aws sagemaker list-cluster-scheduler-configs --cluster-arn "$CLUSTER_ARN" --region "$REGION" \
  --query "ClusterSchedulerConfigSummaries[0].ClusterSchedulerConfigId" --output text 2>/dev/null || true)"
if [[ -n "$EXISTING" && "$EXISTING" != "None" ]]; then
  echo "cluster policy 이미 존재: ${EXISTING} (건너뜀)"
else
  POLICY_ID="$(aws sagemaker create-cluster-scheduler-config --region "$REGION" \
    --name "${CLUSTER_NAME}-policy" --cluster-arn "$CLUSTER_ARN" \
    --description "Workshop: training > inference > background, fair share on" \
    --scheduler-config "file://${GOV_DIR}/cluster-policy.json" \
    --query ClusterSchedulerConfigId --output text)"
  echo "cluster policy 생성: ${POLICY_ID}"
  wait_status aws sagemaker describe-cluster-scheduler-config --region "$REGION" --cluster-scheduler-config-id "$POLICY_ID"
fi

# 2) compute quota — 팀마다 하나.
for TEAM in team-a team-b; do
  EXISTING="$(aws sagemaker list-compute-quotas --cluster-arn "$CLUSTER_ARN" --region "$REGION" \
    --query "ComputeQuotaSummaries[?ComputeQuotaTarget.TeamName=='${TEAM}'].ComputeQuotaId | [0]" --output text 2>/dev/null || true)"
  if [[ -n "$EXISTING" && "$EXISTING" != "None" ]]; then
    echo "compute quota ${TEAM} 이미 존재: ${EXISTING} (건너뜀)"
    continue
  fi
  QUOTA_ID="$(aws sagemaker create-compute-quota --region "$REGION" \
    --name "${CLUSTER_NAME}-${TEAM}" --cluster-arn "$CLUSTER_ARN" \
    --description "Workshop compute allocation for ${TEAM}" \
    --compute-quota-config "file://${GOV_DIR}/compute-quota-${TEAM}.json" \
    --compute-quota-target "{\"TeamName\":\"${TEAM}\",\"FairShareWeight\":50}" \
    --activation-state Enabled \
    --query ComputeQuotaId --output text)"
  echo "compute quota ${TEAM} 생성: ${QUOTA_ID}"
  wait_status aws sagemaker describe-compute-quota --region "$REGION" --compute-quota-id "$QUOTA_ID"
done

echo ""
echo "Kubernetes 리소스 (애드온이 동기화, 최대 1~2분):"
for _ in $(seq 1 24); do
  if kubectl get ns hyperpod-ns-team-a hyperpod-ns-team-b >/dev/null 2>&1; then break; fi
  sleep 5
done
kubectl get clusterqueue 2>/dev/null || true
kubectl get localqueue -A 2>/dev/null || true
kubectl get workloadpriorityclass 2>/dev/null || true
