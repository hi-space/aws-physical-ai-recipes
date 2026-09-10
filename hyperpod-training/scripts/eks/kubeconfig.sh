#!/usr/bin/env bash
# =============================================================================
# kubeconfig.sh — HyperPod EKS 클러스터용 kubectl 설정 + 접속 확인 (모듈 8)
#
# 사용법:
#   ./scripts/eks/kubeconfig.sh [--region <region>] [--cluster <eks-cluster-name>]
#
# 기본 클러스터 이름은 hyperpod-eks-<ACCOUNT_ID> (1인 1계정). 배포자 principal 은 CDK 가 이미
# AmazonEKSClusterAdminPolicy 액세스 엔트리로 등록했으므로 같은 자격증명이면 바로 kubectl 이 동작한다.
# 다른 자격증명이라면 -c eksAdminArns=<arn> 으로 재배포하거나 `aws eks create-access-entry` 를 쓴다.
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
if [[ -z "$CLUSTER_NAME" ]]; then
  ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
  CLUSTER_NAME="hyperpod-eks-${ACCOUNT_ID}"
fi

command -v kubectl >/dev/null || { echo "kubectl 이 없습니다. https://kubernetes.io/docs/tasks/tools/ 참고" >&2; exit 1; }

echo "EKS 클러스터: ${CLUSTER_NAME} (${REGION})"
aws eks update-kubeconfig --name "$CLUSTER_NAME" --region "$REGION" --alias hyperpod-eks >/dev/null
kubectl config use-context hyperpod-eks >/dev/null

echo ""
echo "== 노드 (HyperPod 인스턴스 그룹별) =="
kubectl get nodes -L node.kubernetes.io/instance-type,sagemaker.amazonaws.com/instance-group-name,sagemaker.amazonaws.com/node-health-status
echo ""
echo "== 파드 수 (네임스페이스별; 모두 Running/Completed 이어야 정상) =="
kubectl get pods -A --no-headers 2>/dev/null | awk '{ns[$1]++; if ($4!="Running" && $4!="Completed" && $4!="Succeeded") bad[$1]++} END {for (n in ns) printf "  %-28s %2d pods%s\n", n, ns[n], (bad[n]?"  (" bad[n] " not ready)":"")}' | sort
echo "  (aws-hyperpod 의 health-monitoring-agent 는 GPU/Trainium 노드가 있을 때만 배치됨)"
echo ""
echo "== 애드온 =="
aws eks list-addons --cluster-name "$CLUSTER_NAME" --region "$REGION" --query "addons" --output text | tr '\t' '\n'
