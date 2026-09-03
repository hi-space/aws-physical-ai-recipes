#!/usr/bin/env bash
# 드립피드 쿼터 신청: 계정 전체 동시 오픈 SQI 요청 한도(실측 20건)에 걸리면
# 한 번에 다 신청할 수 없으므로, 슬롯이 빌 때마다 우선순위 순서로 제출한다.
# 전 항목이 충족되거나 오픈 요청으로 커버되면 종료. 재실행해도 안전(멱등).
#
# 사용: nohup ./quota-drip.sh >/tmp/quota-drip.log 2>&1 &
set -u

INTERVAL="${QUOTA_DRIP_INTERVAL:-600}"

# "region|service|quota_code|desired|이름" — 우선순위 순
# (모듈 진행 순서 + GPU 필수 항목 우선, 폴백 타입은 뒤로)
QUEUE=(
  "us-east-1|ec2|L-DB2E81BA|1280|EC2 G/VT vCPU (DCV)"
  "us-west-2|ec2|L-DB2E81BA|1280|EC2 G/VT vCPU (DCV)"
  "us-east-1|sagemaker|L-C6383286|12|ml.g5.12xlarge training (기본)"
  "us-west-2|sagemaker|L-C6383286|12|ml.g5.12xlarge training (기본)"
  "us-east-1|sagemaker|L-24E5A1B2|10|ml.g5.12xlarge cluster (기본 gpu-g5-12x)"
  "us-east-1|sagemaker|L-49E4D2AB|12|ml.g6.xlarge processing (SmokeEval 폴백)"
  "us-west-2|sagemaker|L-49E4D2AB|12|ml.g6.xlarge processing (SmokeEval 폴백)"
  "us-east-1|sagemaker|L-F70A2467|12|ml.g6e.12xlarge training (선택, 더 빠름)"
  "us-west-2|sagemaker|L-F70A2467|12|ml.g6e.12xlarge training (선택, 더 빠름)"
  "us-east-1|sagemaker|L-945D83D8|10|ml.g6e.4xlarge training (선택)"
  "us-west-2|sagemaker|L-945D83D8|10|ml.g6e.4xlarge training (선택)"
  "us-east-1|sagemaker|L-1D84B9D2|12|ml.m5.2xlarge processing"
  "us-west-2|sagemaker|L-1D84B9D2|12|ml.m5.2xlarge processing"
  "us-east-1|sagemaker|L-A15DF696|10|ml.g6e.12xlarge cluster (extended 프로필)"
  "us-east-1|sagemaker|L-50B5B169|12|ml.g6.12xlarge training (폴백)"
  "us-west-2|sagemaker|L-50B5B169|12|ml.g6.12xlarge training (폴백)"
  "us-east-1|sagemaker|L-1FF397C6|10|ml.g6.2xlarge processing (폴백)"
  "us-west-2|sagemaker|L-1FF397C6|10|ml.g6.2xlarge processing (폴백)"
  "us-east-1|sagemaker|L-D8830406|10|ml.g6.12xlarge cluster (폴백)"
  "us-east-1|sagemaker|L-9C8CF3DC|10|ml.g6e.4xlarge cluster (extended 프로필)"
)

log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*"; }

applied_value() { # region service code
  aws service-quotas get-service-quota --region "$1" \
    --service-code "$2" --quota-code "$3" \
    --query 'Quota.Value' --output text 2>/dev/null
}

# 리전·서비스별 오픈 요청(PENDING/CASE_OPENED)의 code->max desired 맵을 "code value" 줄로 출력
open_requests() { # region service
  aws service-quotas list-requested-service-quota-change-history \
    --region "$1" --service-code "$2" --output json 2>/dev/null | python3 -c "
import json, sys
d = json.load(sys.stdin)
m = {}
for r in d.get('RequestedQuotas', []):
    if r['Status'] in ('PENDING', 'CASE_OPENED'):
        m[r['QuotaCode']] = max(m.get(r['QuotaCode'], 0), r['DesiredValue'])
for k, v in m.items():
    print(k, int(v))"
}

cycle=0
while true; do
  cycle=$((cycle + 1))
  log "===== cycle $cycle ====="

  declare -A PENDING=()
  for rs in "us-east-1 sagemaker" "us-west-2 sagemaker" "us-east-1 ec2" "us-west-2 ec2"; do
    set -- $rs
    while read -r code val; do
      [ -n "$code" ] && PENDING["$1|$2|$code"]="$val"
    done < <(open_requests "$1" "$2")
  done

  remaining=0
  slots_full=0
  for item in "${QUEUE[@]}"; do
    IFS='|' read -r REGION SVC CODE WANT NAME <<<"$item"
    CUR="$(applied_value "$REGION" "$SVC" "$CODE")"
    CUR="${CUR%.*}"
    if [ -n "$CUR" ] && [ "$CUR" -ge "$WANT" ]; then
      continue
    fi
    OPEN="${PENDING[$REGION|$SVC|$CODE]:-0}"
    if [ "$OPEN" -ge "$WANT" ]; then
      continue
    fi
    remaining=$((remaining + 1))
    [ "$slots_full" = 1 ] && continue
    ERR="$(aws service-quotas request-service-quota-increase --region "$REGION" \
      --service-code "$SVC" --quota-code "$CODE" --desired-value "$WANT" 2>&1 >/dev/null)"
    if [ -z "$ERR" ]; then
      log "REQUESTED [$REGION] $NAME: ${CUR:-?} -> $WANT"
      remaining=$((remaining - 1))
    elif grep -q QuotaExceededException <<<"$ERR"; then
      log "슬롯 없음 — 이번 사이클 중단 (남은 항목 ${remaining}건, ${INTERVAL}s 후 재시도)"
      slots_full=1
    else
      log "FAILED [$REGION] $NAME: $ERR"
    fi
  done

  if [ "$remaining" -eq 0 ]; then
    log "완료: 모든 항목이 충족되었거나 오픈 요청으로 커버됨. 종료."
    exit 0
  fi
  sleep "$INTERVAL"
done
