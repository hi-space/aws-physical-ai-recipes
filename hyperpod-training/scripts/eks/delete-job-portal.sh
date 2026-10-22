#!/usr/bin/env bash
# =============================================================================
# delete-job-portal.sh — install-job-portal.sh 가 만든 리소스 삭제
#
# 전부 CDK 밖에서 만든 것이라 `cdk destroy` 로는 지워지지 않는다.
#
# 삭제 순서: Ingress(ALB 리스너 규칙) → argo-proxy → Workflow·템플릿·토큰
#            → Helm 릴리스 → ClusterRole → pod identity → 네임스페이스 → IAM 역할
# Ingress 를 먼저 지워야 컨트롤러가 ALB 리스너 규칙과 타겟그룹을 정리한다. ALB 자체는
# IngressGroup 에 Grafana 가 남아 있으면 그대로 유지된다(delete-dashboard-public.sh 담당).
#
# 돌고 있던 Workflow 는 삭제 과정에서 끊긴다. submit 단계의 trap 이 그때 Job 을
# 지우므로, 포탈로 띄운 학습은 함께 멈춘다. CLI 로 직접 띄운 Job 은 건드리지 않는다.
#   --purge-jobs   학습 Job 까지 이름 규칙으로 찾아 삭제 (CLI 로 띄운 것도 포함)
#
# CRD 는 기본으로 남긴다. 지우면 클러스터의 Workflow 기록이 전부 사라지기 때문이다.
#   --remove-crds  argoproj.io CRD + 그 안의 모든 Workflow 기록까지 삭제
#
# 사용법:
#   ./scripts/eks/delete-job-portal.sh [--cluster <eks-cluster-name>] [--yes]
#                                      [--purge-jobs] [--remove-crds]
# =============================================================================
set -euo pipefail

REGION="ap-northeast-2"
NAMESPACE="argo"
WORKFLOW_SA="argo-workflow"
ADMIN_SA="argo-admin"
INGRESS_GROUP="hyperpod-dashboard"

CLUSTER_NAME=""
ASSUME_YES="false"
PURGE_JOBS="false"
REMOVE_CRDS="false"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --cluster) CLUSTER_NAME="$2"; shift 2 ;;
    --yes|-y) ASSUME_YES="true"; shift ;;
    --purge-jobs) PURGE_JOBS="true"; shift ;;
    --remove-crds) REMOVE_CRDS="true"; shift ;;
    *) echo "알 수 없는 옵션: $1" >&2; exit 1 ;;
  esac
done

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
[[ -n "$CLUSTER_NAME" ]] || CLUSTER_NAME="hyperpod-eks-${ACCOUNT_ID}"

RENDER_ROLE="${CLUSTER_NAME}-argo-render"

# 학습 Job 은 라벨이 아니라 이름 규칙으로 찾는다. render.sh 가 붙이는 이름은 포탈로
# 제출했을 때와 가이드의 CLI 명령으로 만들었을 때가 같다. 즉 여기 잡히는 것은
# "포탈이 띄운 것" 만이 아니다. 그래서 기본값은 유지이고, 지울 때는 목록을 보여 준다.
list_jobs() {
  kubectl get jobs -A \
    -o jsonpath='{range .items[*]}{.metadata.namespace}/{.metadata.name}{"\n"}{end}' 2>/dev/null \
    | grep -E '/(mujoco|isaaclab|workshop)-' || true
}
JOB_LIST="$(list_jobs)"

cat <<EOF

삭제 대상 (${CLUSTER_NAME}, ${REGION}):
  Ingress ${NAMESPACE}/argo-server (IngressGroup ${INGRESS_GROUP} 의 /argo 규칙)
  Deployment·Service·ConfigMap argo-proxy (${NAMESPACE})
  WorkflowTemplate 8개 + ConfigMap job-templates (${NAMESPACE})
  ServiceAccount ${ADMIN_SA} + 로그인 토큰 Secret
  ClusterRole/Binding ${CLUSTER_NAME}-argo-job-submit, ${CLUSTER_NAME}-argo-ui
  pod identity ${NAMESPACE}/${WORKFLOW_SA} + IAM 역할 ${RENDER_ROLE}
  Helm 릴리스 argo-workflows + 네임스페이스 ${NAMESPACE}
EOF
if [[ "$PURGE_JOBS" == "true" ]]; then
  echo "  [--purge-jobs] 아래 Job 삭제 — 돌고 있는 학습이 중단됩니다"
  if [[ -n "$JOB_LIST" ]]; then
    echo "$JOB_LIST" | sed 's/^/      /'
  else
    echo "      (해당 Job 없음)"
  fi
else
  echo "  (유지) 학습 Job. 지우려면 --purge-jobs"
fi
if [[ "$REMOVE_CRDS" == "true" ]]; then
  echo "  [--remove-crds] argoproj.io CRD + 모든 Workflow 기록"
else
  echo "  (유지) argoproj.io CRD 와 Workflow 기록. 지우려면 --remove-crds"
fi
cat <<EOF

ALB·WAF·CloudFront·Grafana·MLflow 는 건드리지 않습니다.
k8s-templates 원본과 FSx 의 체크포인트도 그대로 남습니다.

EOF
if [[ "$ASSUME_YES" != "true" ]]; then
  read -r -p "계속할까요? [y/N] " ANSWER
  [[ "$ANSWER" == "y" || "$ANSWER" == "Y" ]] || { echo "중단"; exit 0; }
fi

if kubectl get namespace "$NAMESPACE" >/dev/null 2>&1; then
  # Ingress 를 먼저 지워 ALB 리스너 규칙과 타겟그룹이 정리될 시간을 준다.
  kubectl delete ingress argo-server -n "$NAMESPACE" --ignore-not-found >/dev/null 2>&1 || true
  echo "Ingress 삭제 — ALB 규칙 정리 대기"
  sleep 20

  kubectl delete deployment argo-proxy -n "$NAMESPACE" --ignore-not-found >/dev/null 2>&1 || true
  kubectl delete service argo-proxy -n "$NAMESPACE" --ignore-not-found >/dev/null 2>&1 || true
  kubectl delete configmap argo-proxy -n "$NAMESPACE" --ignore-not-found >/dev/null 2>&1 || true
  echo "argo-proxy 삭제"

  # 돌고 있는 Workflow 를 먼저 끊는다. submit 단계의 trap 이 Job 을 지우므로
  # --purge-jobs 없이도 포탈로 띄워 아직 안 끝난 Job 은 여기서 정리된다.
  if kubectl get workflow -n "$NAMESPACE" >/dev/null 2>&1; then
    kubectl delete workflow --all -n "$NAMESPACE" --wait=false >/dev/null 2>&1 || true
    echo "Workflow 삭제 (실행 중이던 것은 trap 이 Job 을 정리한다)"

    # trap 을 도는 submit 파드가 사라질 때까지 기다린다. 기다리지 않고 바로
    # helm uninstall 을 하면 컨트롤러가 SIGTERM 을 보내기 전에 없어질 수 있고,
    # 그러면 trap 이 아예 돌지 않아 학습 Job 이 GPU 를 물고 남는다.
    for _i in $(seq 1 24); do
      RUNNING="$(kubectl get pods -n "$NAMESPACE" -l workflows.argoproj.io/workflow \
        --field-selector status.phase=Running -o name 2>/dev/null | wc -l | tr -d ' ')"
      [[ "$RUNNING" == "0" ]] && break
      sleep 5
    done
  fi
  kubectl delete workflowtemplate --all -n "$NAMESPACE" --ignore-not-found >/dev/null 2>&1 || true
  kubectl delete configmap job-templates -n "$NAMESPACE" --ignore-not-found >/dev/null 2>&1 || true
  kubectl delete secret "${ADMIN_SA}.service-account-token" -n "$NAMESPACE" \
    --ignore-not-found >/dev/null 2>&1 || true
  echo "WorkflowTemplate + 템플릿 사본 + 토큰 삭제"

  helm uninstall argo-workflows -n "$NAMESPACE" >/dev/null 2>&1 || true
  echo "Helm 릴리스 argo-workflows 삭제"
fi

# ClusterRole/Binding 은 네임스페이스에 속하지 않으므로 따로 지운다.
kubectl delete clusterrolebinding "${CLUSTER_NAME}-argo-job-submit" "${CLUSTER_NAME}-argo-ui" \
  --ignore-not-found >/dev/null 2>&1 || true
kubectl delete clusterrole "${CLUSTER_NAME}-argo-job-submit" \
  --ignore-not-found >/dev/null 2>&1 || true
echo "ClusterRole/Binding 삭제"

if [[ "$PURGE_JOBS" == "true" && -n "$JOB_LIST" ]]; then
  while IFS=/ read -r ns name; do
    [[ -n "$ns" && -n "$name" ]] || continue
    kubectl delete job "$name" -n "$ns" --wait=false >/dev/null 2>&1 || true
    echo "  Job 삭제: ${ns}/${name}"
  done <<<"$JOB_LIST"
fi

PIA_ID="$(aws eks list-pod-identity-associations --cluster-name "$CLUSTER_NAME" --region "$REGION" \
  --namespace "$NAMESPACE" --service-account "$WORKFLOW_SA" \
  --query "associations[0].associationId" --output text 2>/dev/null || true)"
if [[ -n "$PIA_ID" && "$PIA_ID" != "None" ]]; then
  aws eks delete-pod-identity-association --cluster-name "$CLUSTER_NAME" --region "$REGION" \
    --association-id "$PIA_ID" >/dev/null
  echo "pod identity 삭제: ${PIA_ID}"
fi

kubectl delete namespace "$NAMESPACE" --wait=false >/dev/null 2>&1 || true
echo "네임스페이스 ${NAMESPACE} 삭제"

if [[ "$REMOVE_CRDS" == "true" ]]; then
  # 차트는 CRD 를 helm uninstall 로 지우지 않는다(일부러 그렇게 되어 있다).
  for crd in $(kubectl get crd -o name 2>/dev/null | grep 'argoproj.io' || true); do
    kubectl delete "$crd" --ignore-not-found >/dev/null 2>&1 || true
  done
  echo "argoproj.io CRD 삭제"
fi

# IAM 역할은 인라인 정책을 먼저 떼야 지워진다.
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
delete_role "$RENDER_ROLE"

cat <<EOF

완료.

  Grafana·MLflow 는 그대로입니다. ALB 에서 /argo 규칙만 빠졌습니다.
EOF
if [[ "$PURGE_JOBS" != "true" ]]; then
  # 시작 시점의 목록을 그대로 쓰면 안 된다. 돌고 있던 Workflow 의 trap 이 방금
  # 자기 Job 을 지웠을 수 있어서, 이미 없어진 것까지 "남아 있다"고 쓰게 된다.
  REMAINING="$(list_jobs)"
  if [[ -n "$REMAINING" ]]; then
    echo "  아래 Job 은 남아 있습니다 (끝난 것은 ttlSecondsAfterFinished 가 치웁니다):"
    echo "$REMAINING" | sed 's/^/    /'
    echo "  같이 지우려면 이 스크립트를 --purge-jobs 로 다시 실행하세요."
  fi
fi
if [[ "$REMOVE_CRDS" != "true" ]]; then
  cat <<EOF
  argoproj.io CRD 와 Workflow 기록은 남아 있습니다. 다시 설치하면 이전 기록이 그대로
  보입니다. 완전히 지우려면 --remove-crds 로 다시 실행하세요.
EOF
fi
cat <<EOF

  다시 설치 : ./scripts/eks/install-job-portal.sh
EOF
