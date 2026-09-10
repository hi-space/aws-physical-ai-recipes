#!/usr/bin/env bash
# =============================================================================
# render.sh — k8s-templates 의 ${VAR} 를 채워 출력하거나 바로 적용한다 (HyperPod EKS, 모듈 9~10)
#
# 사용법:
#   ./render.sh <template.yaml> [--apply] [--namespace <ns>]
#
# 예시:
#   ./render.sh fsx-pvc.yaml --apply                          # team-a 네임스페이스에 FSx PV+PVC
#   ./render.sh setup/workshop-setup-job.yaml --apply         # /fsx 에 워크숍 코드 준비 (최초 1회)
#   MAX_ITERATIONS=50 ./render.sh rl/isaaclab-train-job.yaml --apply
#   PRIORITY=background-priority ./render.sh rl/isaaclab-train-job.yaml --apply
#   TOTAL_STEPS=1000000 ./render.sh rl/mujoco-train-job.yaml --apply
#   CHECKPOINT=untrained EPISODES=2 ./render.sh rl/mujoco-render-job.yaml --apply
#
# 치환 변수 (환경변수로 덮어쓴다):
#   NAMESPACE       팀 네임스페이스. 기본 hyperpod-ns-team-a (task governance 가 compute quota 생성 시 만든다)
#   QUEUE           Kueue LocalQueue. 기본 ${NAMESPACE}-localqueue
#   PRIORITY        WorkloadPriorityClass. 기본 training-priority (cluster policy 의 <name>-priority)
#   TASK            Isaac Lab: Workshop-SO101-Reach-v0 / MuJoCo: Workshop-SO101-Reach-MuJoCo-v0
#   NUM_ENVS        Isaac Lab 병렬 환경 수 (기본 2048)
#   MAX_ITERATIONS  Isaac Lab PPO iteration (기본 300, ~15–20분)
#   TOTAL_STEPS     MuJoCo 총 env step (기본 1000000, ~5분)
#   LOG_DIR         mujoco-train-job 체크포인트 루트 (기본 /fsx/checkpoints/rl → S3 export). 거버넌스 실습은 /fsx/scratch/governance-demo/<팀>
#   CHECKPOINT      mujoco-render-job 이 재생할 체크포인트 (기본 .../reach-mujoco/SO101_Reach/model_best.zip, 또는 untrained)
#   EPISODES        mujoco-render-job 에피소드 수 (기본 5, 각 10초)
#   JOB_SUFFIX      Job 이름 접미어. 기본 현재 시각(MMDDHHMM) — 같은 이름의 Job 충돌을 피한다
#   FSX_ID / FSX_DNS / FSX_MOUNT / FSX_GIB   fsx-pvc.yaml 용. 비어 있으면 HyperPodEks 스택 Output 에서 읽는다
#   RECIPES_REF     workshop-setup-job 이 clone 할 브랜치 (기본 feat/e2e-workshop)
# =============================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="${1:-}"
shift || true
APPLY=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) APPLY=true; shift ;;
    --namespace) export NAMESPACE="$2"; shift 2 ;;
    *) echo "알 수 없는 옵션: $1" >&2; exit 1 ;;
  esac
done
if [[ -z "$TEMPLATE" ]]; then
  echo "사용법: $0 <template.yaml> [--apply] [--namespace <ns>]" >&2; exit 1
fi
[[ -f "$TEMPLATE" ]] || TEMPLATE="${HERE}/${TEMPLATE}"
[[ -f "$TEMPLATE" ]] || { echo "템플릿을 찾을 수 없습니다: $1" >&2; exit 1; }
command -v envsubst >/dev/null || { echo "envsubst 가 없습니다 (apt-get install gettext-base)" >&2; exit 1; }

export NAMESPACE="${NAMESPACE:-hyperpod-ns-team-a}"
export QUEUE="${QUEUE:-${NAMESPACE}-localqueue}"
export PRIORITY="${PRIORITY:-training-priority}"
export NUM_ENVS="${NUM_ENVS:-2048}"
export MAX_ITERATIONS="${MAX_ITERATIONS:-300}"
export TOTAL_STEPS="${TOTAL_STEPS:-1000000}"
export LOG_DIR="${LOG_DIR:-/fsx/checkpoints/rl}"
export CHECKPOINT="${CHECKPOINT:-/fsx/checkpoints/rl/reach-mujoco/SO101_Reach/model_best.zip}"
export EPISODES="${EPISODES:-5}"
export JOB_SUFFIX="${JOB_SUFFIX:-$(date +%m%d%H%M)}"
export RECIPES_REF="${RECIPES_REF:-feat/e2e-workshop}"
case "$TEMPLATE" in
  *mujoco*) export TASK="${TASK:-Workshop-SO101-Reach-MuJoCo-v0}" ;;
  *)        export TASK="${TASK:-Workshop-SO101-Reach-v0}" ;;
esac

# FSx 값은 fsx-pvc.yaml 에만 필요하다. 스택 Output 에서 읽는다 (1인 1계정: HyperPodEks-<ACCOUNT_ID>).
if [[ "$TEMPLATE" == *fsx-pvc* && ( -z "${FSX_ID:-}" || -z "${FSX_DNS:-}" || -z "${FSX_MOUNT:-}" ) ]]; then
  REGION="${REGION:-${AWS_REGION:-${AWS_DEFAULT_REGION:-$(aws configure get region 2>/dev/null || echo us-east-1)}}}"
  ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
  STACK="${STACK_NAME:-HyperPodEks-${ACCOUNT_ID}}"
  OUT="$(aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
        --query "Stacks[0].Outputs[?OutputKey=='FsxFileSystemId' || OutputKey=='FsxDnsName' || OutputKey=='FsxMountName'].[OutputKey,OutputValue]" \
        --output text)"
  export FSX_ID="${FSX_ID:-$(awk '$1=="FsxFileSystemId"{print $2}' <<<"$OUT")}"
  export FSX_DNS="${FSX_DNS:-$(awk '$1=="FsxDnsName"{print $2}' <<<"$OUT")}"
  export FSX_MOUNT="${FSX_MOUNT:-$(awk '$1=="FsxMountName"{print $2}' <<<"$OUT")}"
  [[ -n "$FSX_ID" && -n "$FSX_DNS" && -n "$FSX_MOUNT" ]] || { echo "스택 ${STACK} 의 FSx Output 을 읽지 못했습니다 (리전 ${REGION})." >&2; exit 1; }
fi
export FSX_GIB="${FSX_GIB:-1200}"

VARS='${NAMESPACE} ${QUEUE} ${PRIORITY} ${TASK} ${NUM_ENVS} ${MAX_ITERATIONS} ${TOTAL_STEPS} ${LOG_DIR} ${CHECKPOINT} ${EPISODES} ${JOB_SUFFIX} ${RECIPES_REF} ${FSX_ID} ${FSX_DNS} ${FSX_MOUNT} ${FSX_GIB}'
if [[ "$APPLY" == true ]]; then
  envsubst "$VARS" < "$TEMPLATE" | kubectl apply -f -
else
  envsubst "$VARS" < "$TEMPLATE"
fi
