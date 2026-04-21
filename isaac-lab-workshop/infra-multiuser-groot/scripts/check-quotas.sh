#!/usr/bin/env bash
# =============================================================================
# check-quotas.sh — Isaac Lab 워크숍 사전 할당량 체크 (관리자용)
#
# 현재 리소스 사용량을 조회한 뒤, N명 추가 배포에 필요한 할당량이
# 충분한지 확인한다. 부족하면 자동 증가 요청도 가능.
#
# 사용법:
#   ./scripts/check-quotas.sh -n 10                  # 10명 배포 예정
#   ./scripts/check-quotas.sh -n 10 --auto-request   # 부족 시 자동 증가 요청
#   ./scripts/check-quotas.sh -n 20 -r us-west-2
# =============================================================================
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'

REGION="${AWS_DEFAULT_REGION:-$(aws configure get region 2>/dev/null || echo 'us-east-1')}"
NUM_USERS=""
AUTO_REQUEST=false

while [[ $# -gt 0 ]]; do
  case $1 in
    -n) NUM_USERS="$2"; shift 2 ;;
    -r) REGION="$2"; shift 2 ;;
    --auto-request) AUTO_REQUEST=true; shift ;;
    -h|--help) echo "Usage: $0 -n NUM_USERS [-r REGION] [--auto-request]"; exit 0 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

if [[ -z "$NUM_USERS" ]]; then
  echo "Error: -n NUM_USERS 필수"
  echo "Usage: $0 -n NUM_USERS [-r REGION] [--auto-request]"
  exit 1
fi

echo "============================================"
echo " Isaac Lab Quota Pre-check"
echo " Region: ${REGION}  |  추가 배포: ${NUM_USERS}명"
echo "============================================"
echo ""

FAIL=0

# ── 할당량 조회 ──
get_quota() {
  local svc="$1" code="$2"
  local val
  val=$(aws service-quotas get-service-quota \
    --service-code "$svc" --quota-code "$code" \
    --region "$REGION" --query 'Quota.Value' --output text 2>/dev/null || echo "")
  if [[ -z "$val" || "$val" == "None" || "$val" == "null" ]]; then
    val=$(aws service-quotas get-aws-default-service-quota \
      --service-code "$svc" --quota-code "$code" \
      --region "$REGION" --query 'Quota.Value' --output text 2>/dev/null || echo "")
  fi
  if [[ -z "$val" || "$val" == "None" || "$val" == "null" ]]; then
    echo "N/A"
  else
    echo "${val%.*}"
  fi
}

# ── 증가 요청 ──
request_increase() {
  local svc="$1" code="$2" desired="$3"
  echo -n "    → 증가 요청 ($desired)... "
  local result
  result=$(aws service-quotas request-service-quota-increase \
    --service-code "$svc" --quota-code "$code" \
    --desired-value "$desired" --region "$REGION" \
    --query 'RequestedQuota.Id' --output text 2>&1) || true
  if [[ "$result" == *"already"* ]] || [[ "$result" == *"ALREADY"* ]]; then
    echo -e "${YELLOW}이미 요청 진행 중${NC}"
  elif [[ -n "$result" ]] && [[ "$result" != *"rror"* ]]; then
    echo -e "${GREEN}완료 (${result})${NC}"
  else
    echo -e "${RED}실패 — 콘솔에서 수동 요청 필요${NC}"
  fi
}

# ── 체크: 현재 사용량 + 추가분 vs 할당량 ──
# check <desc> <svc> <quota_code> <current_usage> <per_user> [--manual]
# --manual: 자동 증가 요청 대상에서 제외 (별도 티켓 필요)
check() {
  local desc="$1" svc="$2" code="$3" used="$4" per_user="$5" manual="${6:-}"
  local extra=$(( per_user * NUM_USERS ))
  local needed=$(( used + extra ))
  local quota
  quota=$(get_quota "$svc" "$code")

  if [[ "$quota" == "N/A" || ! "$quota" =~ ^[0-9]+$ ]]; then
    printf "  ${YELLOW}[SKIP]${NC} %-45s (조회 불가)\n" "$desc"
    return
  fi

  if (( quota >= needed )); then
    printf "  ${GREEN}[ OK ]${NC} %-45s 현재 %s + %s명분 %s = %s / 한도 %s\n" \
      "$desc" "$used" "$NUM_USERS" "$extra" "$needed" "$quota"
  else
    printf "  ${RED}[FAIL]${NC} %-45s 현재 %s + %s명분 %s = %s / 한도 %s\n" \
      "$desc" "$used" "$NUM_USERS" "$extra" "$needed" "$quota"
    FAIL=1
    if [[ "$manual" == "--manual" ]]; then
      echo "    ⚠️  별도 티켓으로 증가 요청 필요"
    elif $AUTO_REQUEST; then
      local req_val=$(( needed + (extra / 5 > 0 ? extra / 5 : 1) ))
      request_increase "$svc" "$code" "$req_val"
    fi
  fi
}

# ==========================================================================
# 현재 사용량 수집
# ==========================================================================
echo -e "${CYAN}현재 리소스 사용량 조회 중...${NC}"

VPC_COUNT=$(aws ec2 describe-vpcs --region "$REGION" \
  --query 'length(Vpcs)' --output text 2>/dev/null || echo 0)

IGW_COUNT=$(aws ec2 describe-internet-gateways --region "$REGION" \
  --query 'length(InternetGateways)' --output text 2>/dev/null || echo 0)

EIP_COUNT=$(aws ec2 describe-addresses --region "$REGION" \
  --query 'length(Addresses)' --output text 2>/dev/null || echo 0)

NAT_COUNT=$(aws ec2 describe-nat-gateways --region "$REGION" \
  --filter "Name=state,Values=available,pending" \
  --query 'length(NatGateways)' --output text 2>/dev/null || echo 0)

EFS_COUNT=$(aws efs describe-file-systems --region "$REGION" \
  --query 'length(FileSystems)' --output text 2>/dev/null || echo 0)

CF_COUNT=$(aws cloudfront list-distributions \
  --query 'DistributionList.Quantity' --output text 2>/dev/null || echo 0)
[[ "$CF_COUNT" =~ ^[0-9]+$ ]] || CF_COUNT=0

SECRET_COUNT=$(aws secretsmanager list-secrets --region "$REGION" \
  --query 'length(SecretList)' --output text 2>/dev/null || echo 0)
[[ "$SECRET_COUNT" =~ ^[0-9]+$ ]] || SECRET_COUNT=0

CFN_COUNT=$(aws cloudformation list-stacks --region "$REGION" \
  --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE CREATE_IN_PROGRESS UPDATE_IN_PROGRESS \
  --query 'length(StackSummaries)' --output text 2>/dev/null || echo 0)
[[ "$CFN_COUNT" =~ ^[0-9]+$ ]] || CFN_COUNT=0

SG_COUNT=$(aws ec2 describe-security-groups --region "$REGION" \
  --query 'length(SecurityGroups)' --output text 2>/dev/null || echo 0)
[[ "$SG_COUNT" =~ ^[0-9]+$ ]] || SG_COUNT=0

GPU_VCPU=$(aws ec2 describe-instances --region "$REGION" \
  --filters "Name=instance-state-name,Values=running" \
  --query 'Reservations[].Instances[?starts_with(InstanceType,`g`) || starts_with(InstanceType,`vt`)].CpuOptions.{c:CoreCount,t:ThreadsPerCore}' \
  --output json 2>/dev/null | python3 -c "
import sys,json
data=json.load(sys.stdin)
print(sum(i['c']*i['t'] for sub in data for i in sub if i))
" 2>/dev/null || echo 0)

echo ""

# ==========================================================================
# 체크 (사용자당 리소스: VPC 1, IGW 1, NAT 1, EIP 1, EFS 1, CF 1, Secret 1, CFN 1, SG 3, vCPU 16~48)
# vCPU는 fallback 최대치(g6.12xlarge=48) 기준으로 체크
# ==========================================================================
echo "── VPC ──"
check "VPCs per Region"              "vpc" "L-F678F1CE" "$VPC_COUNT" 1
check "Internet Gateways"            "vpc" "L-A4707A72" "$IGW_COUNT" 1
check "NAT Gateways per AZ"          "vpc" "L-FE5A380F" "$NAT_COUNT" 1

echo ""
echo "── EC2 ──"
check "Elastic IPs"                  "ec2" "L-0263D0A3" "$EIP_COUNT" 1
check "G/VT On-Demand vCPU"          "ec2" "L-3819A6DF" "$GPU_VCPU" 48 --manual

echo ""
echo "── Storage & CDN ──"
check "EFS File Systems"             "elasticfilesystem" "L-848C634D" "$EFS_COUNT" 1
check "CloudFront Distributions"     "cloudfront" "L-24B04930" "$CF_COUNT" 1

echo ""
echo "── Other ──"
check "Secrets Manager Secrets"      "secretsmanager" "L-2F66C23C" "$SECRET_COUNT" 1
check "CloudFormation Stacks"        "cloudformation" "L-0485CB21" "$CFN_COUNT" 1
check "Security Groups"              "vpc" "L-E79EC296" "$SG_COUNT" 3

# ==========================================================================
# 결과
# ==========================================================================
echo ""
echo "============================================"
if (( FAIL == 0 )); then
  echo -e " ${GREEN}✅ 할당량 충분 — ${NUM_USERS}명 배포 가능${NC}"
else
  echo -e " ${RED}❌ 할당량 부족 항목 있음${NC}"
  if ! $AUTO_REQUEST; then
    echo "    --auto-request 옵션으로 자동 증가 요청 가능"
  fi
fi
echo "============================================"

exit $FAIL
