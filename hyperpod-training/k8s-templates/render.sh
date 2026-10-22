#!/usr/bin/env bash
# =============================================================================
# render.sh — k8s-templates 의 ${VAR} 를 채워 출력하거나 바로 적용한다 (HyperPod EKS, 모듈 9~11)
#
# 사용법:
#   ./render.sh <template.yaml> [--apply] [--namespace <ns>]
#
# 예시 (모듈 9~10: 일반 네임스페이스 rl, Kueue 없이 바로 스케줄):
#   ./render.sh fsx-pvc.yaml --apply                          # rl 네임스페이스에 FSx PV+PVC (네임스페이스가 없으면 만든다)
#   ./render.sh setup/workshop-setup-job.yaml --apply         # /fsx 에 워크숍 코드 준비 (최초 1회)
#   TOTAL_STEPS=1000000 ./render.sh rl/mujoco-train-job.yaml --apply
#   MAX_ITERATIONS=50 ./render.sh rl/isaaclab-train-job.yaml --apply
#   CHECKPOINT=untrained EPISODES=2 ./render.sh rl/mujoco-render-job.yaml --apply
#   ./render.sh rl/isaaclab-play-job.yaml --apply                  # GPU 노드 DCV 데스크톱에 Isaac Sim 재생 (모듈 10 §10.7 방법 B)
# 예시 (모듈 11: 팀 네임스페이스, task governance 큐를 거친다):
#   NAMESPACE=hyperpod-ns-team-a ./render.sh fsx-pvc.yaml --apply
#   NAMESPACE=hyperpod-ns-team-a PRIORITY=background-priority ./render.sh rl/mujoco-train-job.yaml --apply
#
# 치환 변수 (환경변수로 덮어쓴다):
#   NAMESPACE       네임스페이스. 기본 rl (일반 네임스페이스, --apply 시 없으면 생성).
#                   hyperpod-ns-<팀> 을 주면 task governance 가 compute quota 생성 시 만든 팀 네임스페이스를 쓴다.
#   QUEUE           Kueue LocalQueue. NAMESPACE 가 hyperpod-ns-* 이면 기본 ${NAMESPACE}-localqueue, 그 외에는 비어 있다.
#                   비어 있으면 렌더 결과에서 kueue.x-k8s.io/* 라벨 줄을 제거해 Job 이 큐를 거치지 않고 바로 스케줄된다.
#   PRIORITY        WorkloadPriorityClass. 기본 training-priority (cluster policy 의 <name>-priority). QUEUE 가 있을 때만 쓰인다.
#   TASK            Isaac Lab: Workshop-SO101-Reach-v0 / MuJoCo: Workshop-SO101-Reach-MuJoCo-v0
#   NUM_ENVS        Isaac Lab 병렬 환경 수 (기본 2048)
#   MAX_ITERATIONS  Isaac Lab PPO iteration (기본 300, ~15–20분)
#   TOTAL_STEPS     MuJoCo 총 env step (기본 1000000, ~5분)
#   LOG_DIR         mujoco-train-job 체크포인트 루트 (기본 /fsx/checkpoints/rl → S3 export). 거버넌스 실습은 /fsx/scratch/governance-demo/<팀>
#   CHECKPOINT      mujoco-render-job 이 재생할 체크포인트 (기본 .../reach-mujoco/SO101_Reach/model_best.zip, 또는 untrained)
#                   isaaclab-play-job 에서는 기본 /fsx/checkpoints/rl/reach/SO101_Reach/model_best.pt
#   PLAY_ENVS       isaaclab-play-job 이 그릴 환경 수 (기본 4)
#   X_DISPLAY       isaaclab-play-job 이 창을 띄울 노드의 X 디스플레이 (기본 비움 = DCV 가상 세션 자동 선택)
#   EPISODES        mujoco-render-job 에피소드 수 (기본 5, 각 10초)
#   JOB_SUFFIX      Job 이름 접미어. 기본 현재 시각(MMDDHHMM) — 같은 이름의 Job 충돌을 피한다
#   FSX_ID / FSX_DNS / FSX_MOUNT / FSX_GIB   fsx-pvc.yaml 용. 비어 있으면 HyperPodEks 스택 Output 에서 읽는다
#   DATASET_PATH    openloop-eval-job 이 채점 기준으로 쓸 LeRobot 데이터셋
#                   (기본 /fsx/datasets/groot/so101-place-orange — Slurm 쪽 finetune_groot_venv.sbatch 의
#                    DATASET_PATH=/fsx/datasets/groot/<DATASET> 규약과 같은 경로를 쓴다)
#   NUM_EPISODES    openloop-eval-job 평가 에피소드 수 (기본 12)
#   EMBODIMENT_TAG  openloop-eval-job 의 embodiment (기본 NEW_EMBODIMENT, 파인튜닝과 같아야 한다)
#   MLFLOW_TRACKING_URI  isaaclab-train-job / groot-finetune-job / openloop-eval-job 용. 비어 있으면
#                   HyperPodEks 스택의 MlflowTrackingUri Output 에서 읽고, Output 이 없으면
#                   (enableMlflow=false 로 배포) 빈 값 = MLflow 추적 비활성
#   MLFLOW_EXPERIMENT_NAME  실험 이름. 템플릿별 기본값이 있다
#                   (RL 은 isaaclab-rl, VLA 파인튜닝은 vla-finetune, 평가는 vla-eval).
#                   세 종류 run 을 한 실험에 섞으면 대시보드 패널이 서로를 끌어온다
#   RECIPES_REF     workshop-setup-job 이 clone 할 브랜치 (기본 feat/e2e-workshop)
#   GROOT_VERSION   groot-setup-job / groot-finetune-job 의 GR00T 버전 (기본 n1.6, 또는 n1.7)
#                   n1.7 은 gated 모델이라 hf-token Secret 이 필요하다
#   DATASET         /fsx/datasets/groot/<DATASET> 의 디렉터리 이름 (기본 so101-place-orange).
#                   DATASET_PATH 는 이 값으로 만든 전체 경로이고, 직접 주면 그 값이 이긴다
#   MAX_STEPS       groot-finetune-job 학습 step (기본 2000, g5.8xlarge 1장 약 40분)
#   GLOBAL_BATCH_SIZE  groot-finetune-job 글로벌 배치 (기본 32)
#   OUTPUT_DIR      groot-finetune-job 체크포인트 출력 (기본 /fsx/checkpoints/vla/groot-<DATASET>)
#                   openloop-eval-job 의 CHECKPOINT 기본값이 이 경로를 가리킨다
#   ARTIFACT_BUCKET groot-finetune-job 이 MLflow Model Registry 에 넣을 S3 URI 의 버킷.
#                   비어 있으면 HyperPodEks 스택의 S3BucketName Output 에서 읽는다.
#                   끝까지 비면 모델 등록만 건너뛰고 학습은 그대로 진행된다
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

export NAMESPACE="${NAMESPACE:-rl}"
if [[ -z "${QUEUE+x}" ]]; then
  case "$NAMESPACE" in
    hyperpod-ns-*) QUEUE="${NAMESPACE}-localqueue" ;;   # 팀 네임스페이스: task governance 큐를 거친다
    *)             QUEUE="" ;;                          # 일반 네임스페이스: Kueue 라벨 없이 바로 스케줄
  esac
fi
export QUEUE
export PRIORITY="${PRIORITY:-training-priority}"
export NUM_ENVS="${NUM_ENVS:-2048}"
export MAX_ITERATIONS="${MAX_ITERATIONS:-300}"
export TOTAL_STEPS="${TOTAL_STEPS:-1000000}"
export LOG_DIR="${LOG_DIR:-/fsx/checkpoints/rl}"
case "$TEMPLATE" in
  *isaaclab-play*)  export CHECKPOINT="${CHECKPOINT:-/fsx/checkpoints/rl/reach/SO101_Reach/model_best.pt}" ;;
  *openloop-eval*)  export CHECKPOINT="${CHECKPOINT:-/fsx/checkpoints/vla/groot-so101-place-orange/checkpoint-2000}" ;;
  *)                export CHECKPOINT="${CHECKPOINT:-/fsx/checkpoints/rl/reach-mujoco/SO101_Reach/model_best.zip}" ;;
esac
export PLAY_ENVS="${PLAY_ENVS:-4}"
export X_DISPLAY="${X_DISPLAY:-}"
export EPISODES="${EPISODES:-5}"
# GR00T 파인튜닝 관련 기본값은 Slurm 쪽 finetune_groot_venv.sbatch 와 같게 둔다.
# 두 경로가 같은 체크포인트 경로를 쓰므로 openloop-eval 이 어느 쪽 산출물이든 읽는다.
export GROOT_VERSION="${GROOT_VERSION:-n1.6}"
export DATASET="${DATASET:-so101-place-orange}"
export DATASET_PATH="${DATASET_PATH:-/fsx/datasets/groot/${DATASET}}"
export MAX_STEPS="${MAX_STEPS:-2000}"
export GLOBAL_BATCH_SIZE="${GLOBAL_BATCH_SIZE:-32}"
export OUTPUT_DIR="${OUTPUT_DIR:-/fsx/checkpoints/vla/groot-${DATASET}}"
export NUM_EPISODES="${NUM_EPISODES:-12}"
# 파인튜닝이 --embodiment-tag NEW_EMBODIMENT 로 학습하므로 평가도 같아야 한다.
# eval_closed_loop.py 의 argparse 기본값은 OXE_DROID_RELATIVE_EEF_RELATIVE_JOINT 이고,
# 그대로 두면 학습과 다른 태그로 채점해 MSE 가 부풀려진다.
export EMBODIMENT_TAG="${EMBODIMENT_TAG:-NEW_EMBODIMENT}"
export JOB_SUFFIX="${JOB_SUFFIX:-$(date +%m%d%H%M)}"
export RECIPES_REF="${RECIPES_REF:-feat/e2e-workshop}"
case "$TEMPLATE" in
  *mujoco*) export TASK="${TASK:-Workshop-SO101-Reach-MuJoCo-v0}" ;;
  *)        export TASK="${TASK:-Workshop-SO101-Reach-v0}" ;;
esac

# 실험 이름은 템플릿별로 다르다. 평가 run 과 학습 run 이 같은 실험에 섞이면 Grafana 의
# openloop_* 패널과 Train_mean_reward 패널이 서로의 run 을 끌어오므로 분리한다.
case "$TEMPLATE" in
  *openloop-eval*)   export MLFLOW_EXPERIMENT_NAME="${MLFLOW_EXPERIMENT_NAME:-vla-eval}" ;;
  *groot-finetune*)  export MLFLOW_EXPERIMENT_NAME="${MLFLOW_EXPERIMENT_NAME:-vla-finetune}" ;;
  *)                 export MLFLOW_EXPERIMENT_NAME="${MLFLOW_EXPERIMENT_NAME:-isaaclab-rl}" ;;
esac

# MLflow tracking URI 는 학습(isaaclab-train)과 평가(openloop-eval) Job 에 필요하다. 둘 중 하나가 쓰인다.
#   1. 클러스터 안의 자체 호스팅 MLflow (scripts/eks/install-mlflow-selfhosted.sh). Service 가 있으면 이걸 쓴다.
#      basic auth 자격증명은 mlflow 네임스페이스의 mlflow-credentials Secret 에 있고, 템플릿이
#      MLFLOW_TRACKING_USERNAME / _PASSWORD 를 secretKeyRef 로 읽는다. presigned URL 이 필요 없다.
#   2. SageMaker 관리형 MLflow. `-c enableMlflow=true` 로 배포했을 때만 Output 이 존재한다.
# 둘 다 없으면 빈 값으로 둔다 (examples/rl/mlflow_isaaclab.py 가 no-op 으로 동작).
if [[ ( "$TEMPLATE" == *isaaclab-train* || "$TEMPLATE" == *openloop-eval* || "$TEMPLATE" == *groot-finetune* ) \
      && -z "${MLFLOW_TRACKING_URI:-}" ]]; then
  if kubectl get service mlflow -n mlflow >/dev/null 2>&1; then
    MLFLOW_TRACKING_URI="http://mlflow.mlflow.svc.cluster.local/mlflow"
    echo "MLflow 추적 활성화 (자체 호스팅): ${MLFLOW_TRACKING_URI}" >&2
  else
    REGION="${REGION:-${AWS_REGION:-${AWS_DEFAULT_REGION:-$(aws configure get region 2>/dev/null || echo us-east-1)}}}"
    ACCOUNT_ID="${ACCOUNT_ID:-$(aws sts get-caller-identity --query Account --output text)}"
    STACK="${STACK_NAME:-HyperPodEks-${ACCOUNT_ID}}"
    MLFLOW_TRACKING_URI="$(aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
          --query "Stacks[0].Outputs[?OutputKey=='MlflowTrackingUri'].OutputValue | [0]" --output text 2>/dev/null || true)"
    [[ "$MLFLOW_TRACKING_URI" == "None" ]] && MLFLOW_TRACKING_URI=""
    [[ -n "$MLFLOW_TRACKING_URI" ]] && echo "MLflow 추적 활성화 (관리형): ${MLFLOW_TRACKING_URI}" >&2
  fi
fi
export MLFLOW_TRACKING_URI="${MLFLOW_TRACKING_URI:-}"

# 파인튜닝 Job 이 체크포인트를 MLflow Model Registry 에 등록할 때 S3 URI 를 만들어야 한다.
# 버킷 이름을 여기서 넣어 주는 이유는 Job 쪽 role 에 cloudformation:DescribeStacks 가
# 없어서다 — rl 네임스페이스의 default SA 는 MLflow 용 role 이고 sagemaker-mlflow 와
# S3 권한만 가진다. 빈 값이면 register_groot_model.py 가 경고만 남기고 등록을 건너뛴다.
if [[ "$TEMPLATE" == *groot-finetune* && -z "${ARTIFACT_BUCKET:-}" ]]; then
  REGION="${REGION:-${AWS_REGION:-${AWS_DEFAULT_REGION:-$(aws configure get region 2>/dev/null || echo us-east-1)}}}"
  ACCOUNT_ID="${ACCOUNT_ID:-$(aws sts get-caller-identity --query Account --output text)}"
  STACK="${STACK_NAME:-HyperPodEks-${ACCOUNT_ID}}"
  ARTIFACT_BUCKET="$(aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
        --query "Stacks[0].Outputs[?OutputKey=='S3BucketName'].OutputValue | [0]" --output text 2>/dev/null || true)"
  [[ "$ARTIFACT_BUCKET" == "None" ]] && ARTIFACT_BUCKET=""
fi
export ARTIFACT_BUCKET="${ARTIFACT_BUCKET:-}"

# FSx 값은 fsx-pvc.yaml 에만 필요하다. 스택 Output 에서 읽는다 (1인 1계정: HyperPodEks-<ACCOUNT_ID>).
if [[ "$TEMPLATE" == *fsx-pvc* && ( -z "${FSX_ID:-}" || -z "${FSX_DNS:-}" || -z "${FSX_MOUNT:-}" ) ]]; then
  REGION="${REGION:-${AWS_REGION:-${AWS_DEFAULT_REGION:-$(aws configure get region 2>/dev/null || echo us-east-1)}}}"
  ACCOUNT_ID="${ACCOUNT_ID:-$(aws sts get-caller-identity --query Account --output text)}"
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

VARS='${NAMESPACE} ${QUEUE} ${PRIORITY} ${TASK} ${NUM_ENVS} ${MAX_ITERATIONS} ${TOTAL_STEPS} ${LOG_DIR} ${CHECKPOINT} ${EPISODES} ${PLAY_ENVS} ${X_DISPLAY} ${DATASET} ${DATASET_PATH} ${NUM_EPISODES} ${EMBODIMENT_TAG} ${JOB_SUFFIX} ${RECIPES_REF} ${FSX_ID} ${FSX_DNS} ${FSX_MOUNT} ${FSX_GIB} ${MLFLOW_TRACKING_URI} ${MLFLOW_EXPERIMENT_NAME} ${GROOT_VERSION} ${MAX_STEPS} ${GLOBAL_BATCH_SIZE} ${OUTPUT_DIR} ${ARTIFACT_BUCKET}'

render() {
  if [[ -n "$QUEUE" ]]; then
    envsubst "$VARS" < "$TEMPLATE"
  else
    envsubst "$VARS" < "$TEMPLATE" | grep -v 'kueue.x-k8s.io/'   # 큐가 없으면 Kueue 라벨 줄을 뺀다
  fi
}

if [[ "$APPLY" == true ]]; then
  if ! kubectl get namespace "$NAMESPACE" >/dev/null 2>&1; then
    case "$NAMESPACE" in
      hyperpod-ns-*) echo "네임스페이스 ${NAMESPACE} 가 없습니다. 먼저 scripts/eks/create-governance.sh 로 compute quota 를 만드세요 (모듈 11)." >&2; exit 1 ;;
      *) kubectl create namespace "$NAMESPACE" ;;
    esac
  fi
  # 자체 호스팅 MLflow 를 쓰면 basic auth 자격증명이 Job 네임스페이스에도 있어야 한다.
  # Secret 은 네임스페이스를 넘지 못하므로 mlflow 네임스페이스의 원본을 복사한다.
  if [[ "$MLFLOW_TRACKING_URI" == http*mlflow.mlflow.svc* ]] \
     && ! kubectl get secret mlflow-credentials -n "$NAMESPACE" >/dev/null 2>&1; then
    kubectl get secret mlflow-credentials -n mlflow -o json \
      | jq 'del(.metadata.namespace, .metadata.uid, .metadata.resourceVersion, .metadata.creationTimestamp, .metadata.managedFields, .metadata.annotations)' \
      | kubectl apply -n "$NAMESPACE" -f - >/dev/null
    echo "mlflow-credentials Secret 을 ${NAMESPACE} 로 복사했습니다." >&2
  fi
  render | kubectl apply -f -
else
  render
fi
