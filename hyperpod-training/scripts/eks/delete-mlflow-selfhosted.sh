#!/usr/bin/env bash
# =============================================================================
# delete-mlflow-selfhosted.sh — install-mlflow-selfhosted.sh 가 만든 리소스 삭제
#
# 전부 CDK 밖에서 만든 것이라 `cdk destroy` 로는 지워지지 않는다.
#
# 삭제 순서: Ingress(ALB 리스너 규칙) → TensorBoard → MLflow Helm 릴리스 → Postgres
#            → FSx PV/PVC → Secret → 네임스페이스 → pod identity → IAM 역할
# Ingress 를 먼저 지워야 컨트롤러가 ALB 리스너 규칙과 타겟그룹을 정리한다. ALB 자체는
# IngressGroup 에 Grafana 가 남아 있으면 그대로 유지된다(delete-dashboard-public.sh 담당).
#
# 기본은 데이터를 남긴다. 실험 기록이 담긴 두 곳은 따로 플래그로 지운다:
#   --purge-db        Postgres PVC + PV + 뒤의 EBS 볼륨 (gp3 는 reclaimPolicy=Retain)
#   --purge-artifacts S3 <데이터 버킷>/mlflow-artifacts/ 전체
#   --purge-all       위 둘 다
# aws-ebs-csi-driver 애드온은 기본으로 남긴다. 다른 워크로드가 gp3 PVC 를 쓸 수 있다.
#   --remove-ebs-csi  애드온 + gp3 StorageClass + IAM 역할까지 삭제
#
# 사용법:
#   ./scripts/eks/delete-mlflow-selfhosted.sh [--cluster <eks-cluster-name>] [--yes]
#                                             [--purge-db] [--purge-artifacts] [--purge-all]
#                                             [--remove-ebs-csi]
# =============================================================================
set -euo pipefail

REGION="ap-northeast-2"
NAMESPACE="mlflow"
INGRESS_GROUP="hyperpod-dashboard"

CLUSTER_NAME=""
ASSUME_YES="false"
PURGE_DB="false"
PURGE_ARTIFACTS="false"
REMOVE_EBS_CSI="false"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --cluster) CLUSTER_NAME="$2"; shift 2 ;;
    --yes|-y) ASSUME_YES="true"; shift ;;
    --purge-db) PURGE_DB="true"; shift ;;
    --purge-artifacts) PURGE_ARTIFACTS="true"; shift ;;
    --purge-all) PURGE_DB="true"; PURGE_ARTIFACTS="true"; shift ;;
    --remove-ebs-csi) REMOVE_EBS_CSI="true"; shift ;;
    *) echo "알 수 없는 옵션: $1" >&2; exit 1 ;;
  esac
done

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
[[ -n "$CLUSTER_NAME" ]] || CLUSTER_NAME="hyperpod-eks-${ACCOUNT_ID}"
STACK="${STACK_NAME:-HyperPodEks-${ACCOUNT_ID}}"

EBS_ROLE="${CLUSTER_NAME}-ebs-csi"
MLFLOW_ROLE="${CLUSTER_NAME}-mlflow"

S3_BUCKET="${S3_BUCKET:-$(aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='S3BucketName'].OutputValue | [0]" --output text 2>/dev/null || true)}"
[[ "$S3_BUCKET" == "None" ]] && S3_BUCKET=""

cat <<EOF

삭제 대상 (${CLUSTER_NAME}, ${REGION}):
  Ingress ${NAMESPACE}/mlflow, ${NAMESPACE}/tensorboard (IngressGroup ${INGRESS_GROUP} 의 규칙)
  Deployment tensorboard + FSx PV/PVC (${NAMESPACE})
  Helm 릴리스 mlflow (${NAMESPACE})
  StatefulSet mlflow-postgres (${NAMESPACE})
  Secret mlflow-admin / mlflow-credentials / mlflow-postgres + 네임스페이스 ${NAMESPACE}
  학습 Job 네임스페이스로 복사된 mlflow-credentials Secret
  pod identity ${NAMESPACE}/mlflow + IAM 역할 ${MLFLOW_ROLE}
EOF
if [[ "$PURGE_DB" == "true" ]]; then
  echo "  [--purge-db] Postgres PVC + PV + EBS 볼륨 — 실험 기록이 사라집니다"
else
  echo "  (유지) Postgres PVC/PV. 지우려면 --purge-db"
fi
if [[ "$PURGE_ARTIFACTS" == "true" ]]; then
  echo "  [--purge-artifacts] s3://${S3_BUCKET:-<버킷 미확인>}/mlflow-artifacts/ 전체"
else
  echo "  (유지) S3 아티팩트. 지우려면 --purge-artifacts"
fi
if [[ "$REMOVE_EBS_CSI" == "true" ]]; then
  echo "  [--remove-ebs-csi] aws-ebs-csi-driver 애드온 + gp3 StorageClass + IAM 역할 ${EBS_ROLE}"
else
  echo "  (유지) aws-ebs-csi-driver 애드온 + gp3 StorageClass. 지우려면 --remove-ebs-csi"
fi
cat <<EOF

ALB·WAF·CloudFront·Grafana 는 건드리지 않습니다 (delete-dashboard-public.sh 담당).

EOF
if [[ "$ASSUME_YES" != "true" ]]; then
  read -r -p "계속할까요? [y/N] " ANSWER
  [[ "$ANSWER" == "y" || "$ANSWER" == "Y" ]] || { echo "중단"; exit 0; }
fi

if kubectl get namespace "$NAMESPACE" >/dev/null 2>&1; then
  # Ingress 를 먼저 지워 ALB 리스너 규칙과 타겟그룹이 정리될 시간을 준다.
  kubectl delete ingress mlflow tensorboard -n "$NAMESPACE" --ignore-not-found >/dev/null 2>&1 || true
  echo "Ingress 삭제 — ALB 규칙 정리 대기"
  sleep 20

  kubectl delete deployment tensorboard -n "$NAMESPACE" --ignore-not-found >/dev/null 2>&1 || true
  kubectl delete service tensorboard -n "$NAMESPACE" --ignore-not-found >/dev/null 2>&1 || true
  # FSx PV 는 정적 프로비저닝이라 PVC 를 지워도 파일시스템에는 영향이 없다.
  kubectl delete pvc fsx-pvc -n "$NAMESPACE" --ignore-not-found >/dev/null 2>&1 || true
  kubectl delete pv "fsx-pv-${NAMESPACE}" --ignore-not-found >/dev/null 2>&1 || true
  echo "TensorBoard + FSx PV/PVC 삭제"

  helm uninstall mlflow -n "$NAMESPACE" >/dev/null 2>&1 || true
  echo "Helm 릴리스 mlflow 삭제"

  kubectl delete statefulset mlflow-postgres -n "$NAMESPACE" --ignore-not-found >/dev/null 2>&1 || true
  kubectl delete service mlflow-postgres -n "$NAMESPACE" --ignore-not-found >/dev/null 2>&1 || true
  echo "Postgres 삭제"

  if [[ "$PURGE_DB" == "true" ]]; then
    # StatefulSet 의 volumeClaimTemplate PVC 는 자동으로 지워지지 않는다. gp3 는
    # reclaimPolicy=Retain 이라 PV 와 EBS 볼륨까지 지워야 과금이 끊긴다.
    PV_NAME="$(kubectl get pvc data-mlflow-postgres-0 -n "$NAMESPACE" \
      -o jsonpath='{.spec.volumeName}' 2>/dev/null || true)"
    VOL_ID=""
    [[ -n "$PV_NAME" ]] && VOL_ID="$(kubectl get pv "$PV_NAME" \
      -o jsonpath='{.spec.csi.volumeHandle}' 2>/dev/null || true)"
    kubectl delete pvc data-mlflow-postgres-0 -n "$NAMESPACE" --ignore-not-found >/dev/null 2>&1 || true
    [[ -n "$PV_NAME" ]] && kubectl delete pv "$PV_NAME" --ignore-not-found >/dev/null 2>&1 || true
    if [[ -n "$VOL_ID" ]]; then
      aws ec2 delete-volume --volume-id "$VOL_ID" --region "$REGION" >/dev/null 2>&1 \
        && echo "EBS 볼륨 삭제: ${VOL_ID}" \
        || echo "EBS 볼륨 ${VOL_ID} 를 지우지 못했습니다. 콘솔에서 확인하세요."
    fi
  fi

  # 학습 Job 네임스페이스로 복사된 사본도 지운다 (render.sh 가 복사한 것).
  for ns in $(kubectl get namespace -o jsonpath='{.items[*].metadata.name}'); do
    [[ "$ns" == "$NAMESPACE" ]] && continue
    kubectl delete secret mlflow-credentials -n "$ns" --ignore-not-found >/dev/null 2>&1 || true
  done

  kubectl delete namespace "$NAMESPACE" --wait=false >/dev/null 2>&1 || true
  echo "네임스페이스 ${NAMESPACE} 삭제"
fi

if [[ "$PURGE_ARTIFACTS" == "true" && -n "$S3_BUCKET" ]]; then
  aws s3 rm "s3://${S3_BUCKET}/mlflow-artifacts/" --recursive --region "$REGION" >/dev/null 2>&1 || true
  echo "S3 아티팩트 삭제: s3://${S3_BUCKET}/mlflow-artifacts/"
fi

PIA_ID="$(aws eks list-pod-identity-associations --cluster-name "$CLUSTER_NAME" --region "$REGION" \
  --namespace "$NAMESPACE" --service-account mlflow \
  --query "associations[0].associationId" --output text 2>/dev/null || true)"
if [[ -n "$PIA_ID" && "$PIA_ID" != "None" ]]; then
  aws eks delete-pod-identity-association --cluster-name "$CLUSTER_NAME" --region "$REGION" \
    --association-id "$PIA_ID" >/dev/null
  echo "pod identity 삭제: ${PIA_ID}"
fi

delete_role() {
  local role="$1" name arn
  aws iam get-role --role-name "$role" >/dev/null 2>&1 || return 0
  for name in $(aws iam list-role-policies --role-name "$role" --query 'PolicyNames[]' --output text); do
    aws iam delete-role-policy --role-name "$role" --policy-name "$name" >/dev/null
  done
  for arn in $(aws iam list-attached-role-policies --role-name "$role" \
                 --query 'AttachedPolicies[].PolicyArn' --output text); do
    aws iam detach-role-policy --role-name "$role" --policy-arn "$arn" >/dev/null
  done
  aws iam delete-role --role-name "$role" >/dev/null
  echo "IAM 역할 삭제: ${role}"
}
delete_role "$MLFLOW_ROLE"

if [[ "$REMOVE_EBS_CSI" == "true" ]]; then
  kubectl delete storageclass gp3 --ignore-not-found >/dev/null 2>&1 || true
  # 애드온이 만든 pod identity 는 애드온을 지우면 함께 사라진다.
  if aws eks describe-addon --cluster-name "$CLUSTER_NAME" --region "$REGION" \
     --addon-name aws-ebs-csi-driver >/dev/null 2>&1; then
    aws eks delete-addon --cluster-name "$CLUSTER_NAME" --region "$REGION" \
      --addon-name aws-ebs-csi-driver >/dev/null
    echo "애드온 삭제 대기: aws-ebs-csi-driver"
    aws eks wait addon-deleted --cluster-name "$CLUSTER_NAME" --region "$REGION" \
      --addon-name aws-ebs-csi-driver 2>/dev/null || true
  fi
  delete_role "$EBS_ROLE"
fi

cat <<EOF

완료.
EOF
if [[ "$PURGE_DB" != "true" ]]; then
  cat <<EOF
  Postgres PVC/PV 는 남아 있습니다. 다만 mlflow-postgres Secret 을 지웠으므로 재설치 때
  비밀번호가 새로 생성되어 기존 DB 와 맞지 않습니다. 재설치 전에 PVC 도 지우거나
  (이 스크립트를 --purge-db 로 다시 실행) Secret 을 같은 값으로 복원하세요.
EOF
fi
if [[ "$PURGE_ARTIFACTS" != "true" && -n "$S3_BUCKET" ]]; then
  echo "  S3 아티팩트는 남아 있습니다: s3://${S3_BUCKET}/mlflow-artifacts/"
fi
