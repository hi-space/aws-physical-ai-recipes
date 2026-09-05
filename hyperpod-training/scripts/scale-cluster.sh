#!/usr/bin/env bash
# =============================================================================
# scale-cluster.sh — HyperPod 인스턴스 그룹 노드 수 조정 (CDK 재배포 없이)
#
# HyperPod Slurm은 job 제출 시 노드를 자동으로 올려주지 않는다. 이 스크립트는
# `aws sagemaker update-cluster`로 지정한 인스턴스 그룹의 노드 수만 바꾼다.
# CDK 재배포(-c gpuCount=1)와 달리 다른 context 값(createVpc, fsxFileSystemId 등)을
# 기억할 필요가 없고, 몇 초 만에 요청이 접수된다.
#
# 사용법:
#   ./scale-cluster.sh <instance-group> <count> [--wait] [--cluster <name>] [--region <region>]
#
# 예시:
#   ./scale-cluster.sh gpu-g5-8x 1 --wait    # 학습용 GPU 노드 1대 기동 (InService까지 대기)
#   ./scale-cluster.sh gpu-g5-8x 0           # 학습 종료 후 0으로 축소 (비용 절감)
#   ./scale-cluster.sh debug 1 --wait         # DCV 디버그 노드 기동 (모듈 9)
#
# 그룹 이름 (기본 core 프로필): gpu-g5-8x | debug
#   -c gpuGroups=extended 로 배포했다면 추가로: gpu-g6e-12x | gpu-g6e-24x | gpu-g6e-48x
#            | gpu-g6-12x | gpu-g6-24x | gpu-g6-48x | gpu-p4d | gpu-p5
#
# 주의:
#   - 이 스크립트는 CloudFormation 밖에서 노드 수를 바꾸므로 CDK 스택과 드리프트가
#     생긴다. 이후 `cdk deploy`를 다시 실행하면 노드 수가 context 기본값(0)으로
#     돌아가며, `cdk destroy`에는 영향이 없다.
#   - 노드 기동에는 GPU 용량에 따라 10~20분 걸릴 수 있다. --wait 로 InService까지
#     폴링한다.
# =============================================================================
set -euo pipefail

# 워크숍 env(common.sh가 ~/.bashrc에 등록하는 $REGION)를 이후 REGION="" 초기화가
# 지우기 전에 미리 보존해 둔다.
WORKSHOP_REGION="${REGION:-}"

GROUP="${1:-}"
COUNT="${2:-}"
shift 2 2>/dev/null || true

WAIT=false
CLUSTER_NAME=""
REGION=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --wait) WAIT=true; shift ;;
    --cluster) CLUSTER_NAME="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    *) echo "알 수 없는 옵션: $1"; exit 1 ;;
  esac
done

if [[ -z "$GROUP" || -z "$COUNT" ]] || ! [[ "$COUNT" =~ ^[0-9]+$ ]]; then
  echo "사용법: $0 <instance-group> <count> [--wait] [--cluster <name>] [--region <region>]"
  echo "예시:   $0 gpu-g5-8x 1 --wait"
  exit 1
fi

# 리전: --region > $REGION(워크숍 env, common.sh가 ~/.bashrc에 등록) > AWS_REGION
# > AWS_DEFAULT_REGION > aws configure 순서로 해석. 워크숍 DCV 인스턴스는
# AWS_REGION/AWS_DEFAULT_REGION을 설정하지 않으므로(REGION만 등록) $REGION을
# 반드시 먼저 확인해야 한다 — 아니면 us-east-1 폴백으로 조용히 잘못된 리전을
# 조회하게 된다(실측: ap-northeast-1 배포에서 재현).
if [[ -z "$REGION" ]]; then
  REGION="${WORKSHOP_REGION:-${AWS_REGION:-${AWS_DEFAULT_REGION:-$(aws configure get region 2>/dev/null || echo us-east-1)}}}"
fi

# 클러스터 이름 기본값: hyperpod-<ACCOUNT_ID> (1인 1계정 전제)
if [[ -z "$CLUSTER_NAME" ]]; then
  ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
  CLUSTER_NAME="hyperpod-${ACCOUNT_ID}"
fi

echo "클러스터: ${CLUSTER_NAME} (${REGION})"
echo "요청: 그룹 '${GROUP}' 노드 수 → ${COUNT}"

# describe-cluster에서 현재 그룹 스펙을 읽어 InstanceCount만 바꾼 요청 JSON을 만든다.
# UpdateCluster는 전달한 그룹만 갱신하고, 나머지 그룹은 그대로 둔다
# (삭제는 InstanceGroupsToDelete로만 일어난다).
if ! CLUSTER_JSON="$(aws sagemaker describe-cluster \
  --cluster-name "$CLUSTER_NAME" --region "$REGION" --output json 2>/dev/null)"; then
  echo "오류: 클러스터 '${CLUSTER_NAME}' 을(를) 리전 ${REGION} 에서 찾을 수 없습니다."
  echo "      리전이 다르면 --region 으로, 이름이 다르면 --cluster 로 지정하세요."
  exit 1
fi

REQUEST_JSON="$(printf '%s' "$CLUSTER_JSON" | python3 -c "
import json, sys

count = int('${COUNT}')
group_name = '${GROUP}'
cluster = json.load(sys.stdin)

groups = {g['InstanceGroupName']: g for g in cluster['InstanceGroups']}
if group_name not in groups:
    sys.stderr.write(f'그룹 {group_name!r} 이(가) 없습니다. 존재하는 그룹: {sorted(groups)}\n')
    sys.exit(1)

g = groups[group_name]
spec = {
    'InstanceGroupName': g['InstanceGroupName'],
    'InstanceType': g['InstanceType'],
    'InstanceCount': count,
    'LifeCycleConfig': g['LifeCycleConfig'],
    'ExecutionRole': g['ExecutionRole'],
}
# 선택 필드는 있을 때만 그대로 유지한다.
for key in ('ThreadsPerCore', 'InstanceStorageConfigs', 'OnStartDeepHealthChecks',
            'TrainingPlanArn', 'OverrideVpcConfig'):
    if g.get(key) is not None:
        spec[key] = g[key]

print(json.dumps({'ClusterName': '${CLUSTER_NAME}', 'InstanceGroups': [spec]}))
")"

aws sagemaker update-cluster --region "$REGION" --cli-input-json "$REQUEST_JSON" >/dev/null
echo "update-cluster 요청 접수 완료."

if [[ "$WAIT" == true ]]; then
  echo "클러스터가 InService가 될 때까지 대기 중... (GPU 노드 기동은 10~20분 소요)"
  SEEN_UPDATING=false
  while true; do
    DESC="$(aws sagemaker describe-cluster --cluster-name "$CLUSTER_NAME" \
      --region "$REGION" --output json)"
    STATUS="$(printf '%s' "$DESC" | python3 -c "import json,sys; print(json.load(sys.stdin)['ClusterStatus'])")"
    CURRENT="$(printf '%s' "$DESC" | python3 -c "
import json, sys
c = json.load(sys.stdin)
g = next((g for g in c['InstanceGroups'] if g['InstanceGroupName'] == '${GROUP}'), None)
print(g.get('CurrentCount', '?') if g else '?')
")"
    echo "  상태: ${STATUS}, ${GROUP} 현재 노드: ${CURRENT}/${COUNT}"
    if [[ "$STATUS" == "Updating" ]]; then
      SEEN_UPDATING=true
    fi
    if [[ "$STATUS" == "InService" && "$CURRENT" == "$COUNT" ]]; then
      echo "완료: ${GROUP} = ${COUNT}"
      break
    fi
    # 용량 부족(ICE) 등으로 스케일업이 실패하면 클러스터는 조용히 롤백되어
    # InService(노드 0)로 돌아온다. 이때 영원히 대기하지 않도록, Updating 을
    # 지나 InService 로 돌아왔는데 목표 수에 못 미치면 실패로 처리한다.
    if [[ "$STATUS" == "InService" && "$SEEN_UPDATING" == true && "$CURRENT" != "$COUNT" ]]; then
      FAILURE_MSG="$(printf '%s' "$DESC" | python3 -c "import json,sys; print(json.load(sys.stdin).get('FailureMessage') or '')")"
      echo "오류: 스케일업이 롤백되었습니다 (${GROUP} = ${CURRENT}/${COUNT})."
      [[ -n "$FAILURE_MSG" ]] && echo "      원인: ${FAILURE_MSG}"
      echo "      GPU 용량 부족(ICE)이면 잠시 후 재시도하세요 (extended 프로필로 배포했다면 다른 그룹(예: gpu-g6e-12x)도 시도 가능)."
      exit 1
    fi
    if [[ "$STATUS" == "Failed" || "$STATUS" == "RollingBack" ]]; then
      echo "오류: 클러스터 상태가 ${STATUS} 입니다. 콘솔에서 원인을 확인하세요."
      exit 1
    fi
    sleep 30
  done
fi
