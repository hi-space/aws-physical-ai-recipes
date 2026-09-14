#!/usr/bin/env bash
# =============================================================================
# head-node.sh — HyperPod Slurm head node 에 SSM 으로 접속 (ubuntu 사용자 셸)
#
# HyperPod 노드는 private subnet 에 있고 SSM target 형식이
#   sagemaker-cluster:<CLUSTER_ID>_<INSTANCE_GROUP>-<EC2_INSTANCE_ID>
# 라서 매번 클러스터 ID 와 head 인스턴스 ID 를 조회해 조립해야 한다. 이 스크립트가
# 그 조회를 대신하고, SSM 세션을 곧바로 ubuntu 사용자 셸(sudo -iu ubuntu)로 연다.
# (기본 start-session 은 root 로 로그인되므로 sbatch 전에 sudo su - ubuntu 가 필요했다.)
#
# 사용법 (code-server 워크스테이션):
#   ./scripts/head-node.sh                    # head node 에 ubuntu 로 접속
#   ./scripts/head-node.sh --root             # root 셸 (기본 AWS-StartInteractiveCommand 미사용)
#   ./scripts/head-node.sh --print-target     # 접속하지 않고 SSM target 만 출력
#   ./scripts/head-node.sh --cluster <name> --region <region>
#
# 리전/클러스터 이름은 scale-cluster.sh 와 같은 순서로 결정한다:
#   --region > $REGION(워크숍 env) > AWS_REGION > AWS_DEFAULT_REGION > aws configure
#   --cluster > hyperpod-<ACCOUNT_ID>
# =============================================================================
set -euo pipefail

WORKSHOP_REGION="${REGION:-}"
REGION=""
CLUSTER_NAME=""
MODE="ubuntu"
PRINT_ONLY=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --root) MODE="root"; shift ;;
    --print-target) PRINT_ONLY=true; shift ;;
    --cluster) CLUSTER_NAME="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "알 수 없는 옵션: $1 (--root | --print-target | --cluster <name> | --region <region>)"; exit 1 ;;
  esac
done

if [[ -z "$REGION" ]]; then
  REGION="${WORKSHOP_REGION:-${AWS_REGION:-${AWS_DEFAULT_REGION:-$(aws configure get region 2>/dev/null || echo us-east-1)}}}"
fi
if [[ -z "$CLUSTER_NAME" ]]; then
  ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
  CLUSTER_NAME="hyperpod-${ACCOUNT_ID}"
fi

if ! CLUSTER_ARN="$(aws sagemaker describe-cluster --cluster-name "$CLUSTER_NAME" --region "$REGION" \
    --query ClusterArn --output text 2>/dev/null)"; then
  echo "오류: 클러스터 '${CLUSTER_NAME}' 을(를) 리전 ${REGION} 에서 찾을 수 없습니다."
  echo "      리전이 다르면 --region 으로, 이름이 다르면 --cluster 로 지정하세요."
  exit 1
fi
CLUSTER_ID="${CLUSTER_ARN##*/}"

HEAD_INSTANCE_ID="$(aws sagemaker list-cluster-nodes --cluster-name "$CLUSTER_NAME" --region "$REGION" \
  --query "ClusterNodeSummaries[?InstanceGroupName=='head'].InstanceId" --output text | awk '{print $1}')"
if [[ -z "$HEAD_INSTANCE_ID" || "$HEAD_INSTANCE_ID" == "None" ]]; then
  echo "오류: 클러스터 '${CLUSTER_NAME}' 에 'head' 그룹 노드가 없습니다 (aws sagemaker list-cluster-nodes 로 확인)."
  exit 1
fi

TARGET="sagemaker-cluster:${CLUSTER_ID}_head-${HEAD_INSTANCE_ID}"
if [[ "$PRINT_ONLY" == true ]]; then
  echo "$TARGET"
  exit 0
fi

echo "클러스터: ${CLUSTER_NAME} (${REGION})"
echo "SSM target: ${TARGET}"
if [[ "$MODE" == "root" ]]; then
  exec aws ssm start-session --region "$REGION" --target "$TARGET"
fi
# 세션을 ubuntu 사용자의 로그인 셸로 시작한다. 셸에서 exit 하면 세션도 끝난다.
exec aws ssm start-session --region "$REGION" --target "$TARGET" \
  --document-name AWS-StartInteractiveCommand \
  --parameters '{"command":["sudo -iu ubuntu"]}'
