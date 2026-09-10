#!/usr/bin/env bash
# =============================================================================
# dcv-target.sh — HyperPod EKS GPU 노드의 DCV 접속 정보 출력 (모듈 10 §10.7 방법 B)
#
# GPU 노드(gpu-g5-8x)에는 lifecycle 스크립트가 DCV 서버와 'workspace' 가상 세션(ubuntu/hyperpod)을 만들어 둔다.
# 노드는 private subnet 에 있으므로 SSM Session Manager 로 8443 포트를 포워딩해 접속한다.
# HyperPod 노드의 SSM target 형식: sagemaker-cluster:<CLUSTER_ID>_<INSTANCE_GROUP>-<EC2_INSTANCE_ID>
#
# 사용법: ./scripts/eks/dcv-target.sh [--cluster <name>] [--group <instance-group>] [--local-port <port>]
#   기본 cluster hyperpod-eks-<ACCOUNT_ID>, group gpu-g5-8x, local-port 8444 (code-server 인스턴스의 DCV 가 8443 을 씀)
# =============================================================================
set -euo pipefail
REGION="${REGION:-${AWS_REGION:-${AWS_DEFAULT_REGION:-$(aws configure get region 2>/dev/null || echo us-east-1)}}}"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
CLUSTER="hyperpod-eks-${ACCOUNT_ID}"; GROUP="gpu-g5-8x"; LOCAL_PORT=8444
while [[ $# -gt 0 ]]; do
  case "$1" in
    --cluster) CLUSTER="$2"; shift 2 ;;
    --group) GROUP="$2"; shift 2 ;;
    --local-port) LOCAL_PORT="$2"; shift 2 ;;
    *) echo "알 수 없는 옵션: $1" >&2; exit 1 ;;
  esac
done

CLUSTER_ID="$(aws sagemaker describe-cluster --cluster-name "$CLUSTER" --region "$REGION" --query ClusterArn --output text | awk -F/ '{print $NF}')"
INSTANCE_ID="$(aws sagemaker list-cluster-nodes --cluster-name "$CLUSTER" --region "$REGION" \
  --query "ClusterNodeSummaries[?InstanceGroupName=='${GROUP}' && InstanceStatus.Status=='Running'].InstanceId | [0]" --output text)"
if [[ -z "$INSTANCE_ID" || "$INSTANCE_ID" == "None" ]]; then
  echo "그룹 ${GROUP} 에 Running 상태의 노드가 없습니다. 먼저 ./scripts/scale-cluster.sh ${GROUP} 1 --wait --cluster ${CLUSTER}" >&2; exit 1
fi
TARGET="sagemaker-cluster:${CLUSTER_ID}_${GROUP}-${INSTANCE_ID}"

cat <<MSG
=== HyperPod EKS GPU 노드 DCV ===
  클러스터: ${CLUSTER} (${REGION})
  노드:     ${GROUP} / ${INSTANCE_ID}
  SSM target: ${TARGET}

1) 포트포워딩 (이 터미널을 점유합니다. 노트북에서 실행하려면 AWS CLI v2 + Session Manager plugin 필요):
   aws ssm start-session --region ${REGION} \\
     --target ${TARGET} \\
     --document-name AWS-StartPortForwardingSession \\
     --parameters portNumber=8443,localPortNumber=${LOCAL_PORT}

2) 브라우저:
   - 노트북에서 포워딩했다면:            https://localhost:${LOCAL_PORT}   (자체 서명 인증서 경고는 진행)
   - code-server 터미널에서 포워딩했다면: https://<CodeServerUrl>/proxy/8445/   (dcv-tls-bridge 가 8445 → ${LOCAL_PORT} TLS 중계)
   로그인: ubuntu / hyperpod
MSG
