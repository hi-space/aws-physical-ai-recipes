#!/usr/bin/env bash
# =============================================================================
# delete-governance.sh — task governance 정책 삭제 (모듈 12 정리)
#
# 순서: compute quota(팀별) → cluster policy. 정책이 남아 있으면 HyperPod 클러스터 삭제(cdk destroy)가 막힌다.
# 사용법: ./scripts/eks/delete-governance.sh [--region <region>] [--cluster <hyperpod-cluster-name>]
# =============================================================================
set -euo pipefail

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

for ID in $(aws sagemaker list-compute-quotas --cluster-arn "$CLUSTER_ARN" --region "$REGION" \
  --query "ComputeQuotaSummaries[].ComputeQuotaId" --output text); do
  echo "compute quota 삭제: ${ID}"
  aws sagemaker delete-compute-quota --region "$REGION" --compute-quota-id "$ID"
done

# compute quota 삭제가 끝나야 cluster policy 를 지울 수 있다.
for _ in $(seq 1 36); do
  LEFT="$(aws sagemaker list-compute-quotas --cluster-arn "$CLUSTER_ARN" --region "$REGION" \
    --query "length(ComputeQuotaSummaries)" --output text)"
  [[ "$LEFT" == "0" ]] && break
  sleep 5
done

for ID in $(aws sagemaker list-cluster-scheduler-configs --cluster-arn "$CLUSTER_ARN" --region "$REGION" \
  --query "ClusterSchedulerConfigSummaries[].ClusterSchedulerConfigId" --output text); do
  echo "cluster policy 삭제: ${ID}"
  aws sagemaker delete-cluster-scheduler-config --region "$REGION" --cluster-scheduler-config-id "$ID"
done
echo "완료."
