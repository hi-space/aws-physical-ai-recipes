#!/bin/bash
set -e
################################################################################
#                                                                              #
#   VSCode Server on EC2 - 간소화 배포 스크립트                                  #
#   Simplified deployment script                                               #
#                                                                              #
#   사용법:                                                                     #
#     배포: bash deploy.sh                                                      #
#     삭제: bash deploy.sh --delete <stack-name>                                #
#                                                                              #
################################################################################

GREEN='\033[0;32m'; RED='\033[0;31m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'; NC='\033[0m'
BOLD='\033[1m'
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TEMPLATE="$SCRIPT_DIR/cloudformation.yaml"

# --delete 모드 처리
if [ "${1:-}" = "--delete" ]; then
    STACK_NAME="${2:-}"
    if [ -z "$STACK_NAME" ]; then
        echo -e "${RED}사용법: bash deploy.sh --delete <stack-name>${NC}"
        exit 1
    fi
    echo -e "${CYAN}스택 삭제 중 / Deleting stack: $STACK_NAME ...${NC}"
    aws cloudformation delete-stack --stack-name "$STACK_NAME"
    echo -e "${YELLOW}삭제 요청 완료. 완료까지 수 분 소요됩니다.${NC}"
    echo "  상태 확인: aws cloudformation describe-stacks --stack-name $STACK_NAME --query 'Stacks[0].StackStatus'"
    exit 0
fi

echo ""
echo -e "${CYAN}=================================================================${NC}"
echo -e "${CYAN}   VSCode Server on EC2 - 배포 / Deployment${NC}"
echo -e "${CYAN}=================================================================${NC}"
echo ""

###############################################################################
#  [1/5] 사전 점검 / Pre-flight checks                                        #
###############################################################################
echo -e "${CYAN}[1/5] 사전 점검 / Pre-flight checks...${NC}"

if ! command -v aws &>/dev/null; then
    echo -e "${RED}오류: AWS CLI를 찾을 수 없습니다 / ERROR: aws CLI not found${NC}"
    exit 1
fi

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text 2>/dev/null || echo "")
if [ -z "$ACCOUNT_ID" ]; then
    echo -e "${RED}오류: AWS 자격 증명을 확인할 수 없습니다 / ERROR: Cannot verify AWS credentials${NC}"
    exit 1
fi
REGION=$(aws configure get region 2>/dev/null || echo "ap-northeast-2")
echo "  Account: $ACCOUNT_ID"
echo "  Region:  $REGION"

if [ ! -f "$TEMPLATE" ]; then
    echo -e "${RED}오류: CloudFormation 템플릿을 찾을 수 없습니다: $TEMPLATE${NC}"
    exit 1
fi

###############################################################################
#  [2/5] 사용자 입력 / User Input                                              #
###############################################################################
echo ""
echo -e "${CYAN}[2/5] 설정 입력 / Configuration...${NC}"
echo ""

# Stack Name
read -p "  Stack Name (여러 사용자는 각자 다른 이름 사용): " STACK_NAME
if [ -z "$STACK_NAME" ]; then
    echo -e "${RED}오류: Stack Name은 필수입니다${NC}"
    exit 1
fi

# Password
while true; do
    read -sp "  VSCode 비밀번호 (8자 이상): " VSCODE_PASSWORD
    echo ""
    if [ ${#VSCODE_PASSWORD} -ge 8 ]; then
        read -sp "  비밀번호 확인: " VSCODE_PASSWORD_CONFIRM
        echo ""
        if [ "$VSCODE_PASSWORD" = "$VSCODE_PASSWORD_CONFIRM" ]; then
            break
        else
            echo -e "  ${RED}비밀번호가 일치하지 않습니다${NC}"
        fi
    else
        echo -e "  ${RED}8자 이상 입력해주세요${NC}"
    fi
done

# Instance Type
echo ""
echo -e "  ${BOLD}인스턴스 타입 선택:${NC}"
INSTANCE_TYPES=(
    "m7i.2xlarge:x86_64 Intel, 8 vCPU, 32GB (기본값)"
    "m7i.xlarge:x86_64 Intel, 4 vCPU, 16GB"
    "t3.2xlarge:x86_64 Intel, 8 vCPU, 32GB"
    "t3.xlarge:x86_64 Intel, 4 vCPU, 16GB"
    "t3.large:x86_64 Intel, 2 vCPU, 8GB"
    "m7g.2xlarge:ARM64 Graviton, 8 vCPU, 32GB"
    "m7g.xlarge:ARM64 Graviton, 4 vCPU, 16GB"
    "t4g.2xlarge:ARM64 Graviton, 8 vCPU, 32GB"
    "t4g.xlarge:ARM64 Graviton, 4 vCPU, 16GB"
)
for i in "${!INSTANCE_TYPES[@]}"; do
    ITYPE="${INSTANCE_TYPES[$i]%%:*}"
    IDESC="${INSTANCE_TYPES[$i]##*:}"
    printf "    %2d) %-16s %s\n" $((i+1)) "$ITYPE" "$IDESC"
done
echo ""
read -p "  번호 입력 [1]: " ITYPE_CHOICE
ITYPE_CHOICE="${ITYPE_CHOICE:-1}"

if [[ "$ITYPE_CHOICE" =~ ^[0-9]+$ ]] && [ "$ITYPE_CHOICE" -ge 1 ] && [ "$ITYPE_CHOICE" -le "${#INSTANCE_TYPES[@]}" ]; then
    INSTANCE_TYPE="${INSTANCE_TYPES[$((ITYPE_CHOICE-1))]%%:*}"
else
    INSTANCE_TYPE="m7i.2xlarge"
fi
echo -e "  ${GREEN}인스턴스: $INSTANCE_TYPE${NC}"

# EBS Size
echo ""
read -p "  EBS 볼륨 크기 (GB) [100]: " EBS_SIZE
EBS_SIZE="${EBS_SIZE:-100}"

# VPC Name (optional)
echo ""
read -p "  VPC 이름 (미입력시 Default VPC 사용): " VPC_NAME

###############################################################################
#  [3/5] VPC / Subnet 자동 탐색 / Auto-discover VPC & Subnet                  #
###############################################################################
echo ""
echo -e "${CYAN}[3/5] VPC / Subnet 탐색 중...${NC}"

if [ -z "$VPC_NAME" ]; then
    # Default VPC 사용
    VPC_ID=$(aws ec2 describe-vpcs \
        --filters "Name=isDefault,Values=true" \
        --query "Vpcs[0].VpcId" --output text --region "$REGION" 2>/dev/null)

    if [ -z "$VPC_ID" ] || [ "$VPC_ID" = "None" ]; then
        echo -e "${RED}오류: Default VPC를 찾을 수 없습니다. VPC 이름을 지정해주세요.${NC}"
        exit 1
    fi
    echo "  Default VPC 사용: $VPC_ID"
else
    # VPC Name 태그로 검색
    VPC_ID=$(aws ec2 describe-vpcs \
        --filters "Name=tag:Name,Values=$VPC_NAME" \
        --query "Vpcs[0].VpcId" --output text --region "$REGION" 2>/dev/null)

    if [ -z "$VPC_ID" ] || [ "$VPC_ID" = "None" ]; then
        echo -e "${RED}오류: '$VPC_NAME' 이름의 VPC를 찾을 수 없습니다${NC}"
        echo "  사용 가능한 VPC 목록:"
        aws ec2 describe-vpcs --region "$REGION" --output json 2>/dev/null | python3 -c "
import json, sys
vpcs = json.load(sys.stdin).get('Vpcs', [])
for v in vpcs:
    name = next((t['Value'] for t in v.get('Tags', []) if t['Key'] == 'Name'), '(이름 없음)')
    default = ' [Default]' if v.get('IsDefault') else ''
    print('    {} {} {}{}'.format(v['VpcId'], v.get('CidrBlock',''), name, default))
"
        exit 1
    fi
    echo "  VPC '$VPC_NAME' 발견: $VPC_ID"
fi

# Public Subnet 자동 탐색 (IGW route가 있는 route table에 연결된 subnet)
echo "  Public Subnet 탐색 중..."

# 1) IGW가 연결된 route table 찾기
IGW_ROUTE_TABLE_IDS=$(aws ec2 describe-route-tables \
    --filters "Name=vpc-id,Values=$VPC_ID" \
    --query "RouteTables[?Routes[?GatewayId && starts_with(GatewayId, 'igw-')]].RouteTableId" \
    --output text --region "$REGION" 2>/dev/null)

if [ -z "$IGW_ROUTE_TABLE_IDS" ]; then
    echo -e "${RED}오류: IGW가 연결된 Route Table을 찾을 수 없습니다${NC}"
    exit 1
fi

# 2) 해당 route table에 명시적으로 연결된 subnet 찾기
PUBLIC_SUBNET_ID=""
for RT_ID in $IGW_ROUTE_TABLE_IDS; do
    SUBNET_ID=$(aws ec2 describe-route-tables \
        --route-table-ids "$RT_ID" \
        --query "RouteTables[0].Associations[?SubnetId].SubnetId | [0]" \
        --output text --region "$REGION" 2>/dev/null)

    if [ -n "$SUBNET_ID" ] && [ "$SUBNET_ID" != "None" ]; then
        PUBLIC_SUBNET_ID="$SUBNET_ID"
        break
    fi
done

# 3) 명시적 연결이 없으면 Main route table이 IGW를 가진 경우 (Default VPC 패턴)
if [ -z "$PUBLIC_SUBNET_ID" ] || [ "$PUBLIC_SUBNET_ID" = "None" ]; then
    MAIN_RT_HAS_IGW=$(aws ec2 describe-route-tables \
        --filters "Name=vpc-id,Values=$VPC_ID" "Name=association.main,Values=true" \
        --query "RouteTables[?Routes[?GatewayId && starts_with(GatewayId, 'igw-')]].RouteTableId | [0]" \
        --output text --region "$REGION" 2>/dev/null)

    if [ -n "$MAIN_RT_HAS_IGW" ] && [ "$MAIN_RT_HAS_IGW" != "None" ]; then
        # Main route table에 IGW가 있으면 VPC의 아무 subnet이나 public
        PUBLIC_SUBNET_ID=$(aws ec2 describe-subnets \
            --filters "Name=vpc-id,Values=$VPC_ID" \
            --query "Subnets[0].SubnetId" \
            --output text --region "$REGION" 2>/dev/null)
    fi
fi

if [ -z "$PUBLIC_SUBNET_ID" ] || [ "$PUBLIC_SUBNET_ID" = "None" ]; then
    echo -e "${RED}오류: Public Subnet을 찾을 수 없습니다${NC}"
    exit 1
fi

SUBNET_AZ=$(aws ec2 describe-subnets --subnet-ids "$PUBLIC_SUBNET_ID" \
    --query "Subnets[0].AvailabilityZone" --output text --region "$REGION" 2>/dev/null)
echo -e "  ${GREEN}Public Subnet: $PUBLIC_SUBNET_ID ($SUBNET_AZ)${NC}"

###############################################################################
#  [4/5] 설정 확인 / Confirm                                                  #
###############################################################################
echo ""
echo -e "${CYAN}[4/5] 설정 확인 / Confirm...${NC}"
echo ""
echo -e "  ${BOLD}┌─────────────────────────────────────────────┐${NC}"
echo -e "  ${BOLD}│  배포 설정 요약                               │${NC}"
echo -e "  ${BOLD}├─────────────────────────────────────────────┤${NC}"
echo "  │  Stack Name:    $STACK_NAME"
echo "  │  Account:       $ACCOUNT_ID"
echo "  │  Region:        $REGION"
echo "  │  VPC:           $VPC_ID"
echo "  │  Subnet:        $PUBLIC_SUBNET_ID ($SUBNET_AZ)"
echo "  │  Instance Type: $INSTANCE_TYPE"
echo "  │  EBS Size:      ${EBS_SIZE}GB"
echo "  │  Password:      $(printf '*%.0s' $(seq 1 ${#VSCODE_PASSWORD}))"
echo -e "  ${BOLD}└─────────────────────────────────────────────┘${NC}"
echo ""
read -p "  배포를 시작할까요? (y/n) [y]: " CONFIRM
CONFIRM="${CONFIRM:-y}"
[ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ] && { echo "  취소되었습니다."; exit 0; }

###############################################################################
#  [5/5] CloudFormation 배포 / Deploy                                         #
###############################################################################
echo ""
echo -e "${CYAN}[5/5] CloudFormation 배포 중... (약 3-5분)${NC}"
echo ""

aws cloudformation deploy \
    --stack-name "$STACK_NAME" \
    --template-file "$TEMPLATE" \
    --capabilities CAPABILITY_NAMED_IAM \
    --parameter-overrides \
        VpcId="$VPC_ID" \
        PublicSubnetId="$PUBLIC_SUBNET_ID" \
        InstanceType="$INSTANCE_TYPE" \
        VSCodePassword="$VSCODE_PASSWORD" \
        EBSVolumeSize="$EBS_SIZE" \
    --region "$REGION"

###############################################################################
#  결과 출력 / Output Results                                                  #
###############################################################################
echo ""
OUTPUTS=$(aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" --region "$REGION" \
    --query "Stacks[0].Outputs" --output json 2>/dev/null || echo "[]")

parse_output() {
    echo "$OUTPUTS" | python3 -c "import json,sys;o={i['OutputKey']:i['OutputValue'] for i in json.load(sys.stdin)};print(o.get('$1','N/A'))" 2>/dev/null || echo "N/A"
}

VSCODE_URL=$(parse_output "VSCodeURL")
INSTANCE_ID=$(parse_output "InstanceId")
PUBLIC_IP=$(parse_output "PublicIP")
SSM_CMD=$(parse_output "SSMCommand")
ROLE_NAME=$(parse_output "IAMRoleName")

echo -e "${GREEN}=================================================================${NC}"
echo -e "${GREEN}   배포 완료 / Deployment Complete${NC}"
echo -e "${GREEN}=================================================================${NC}"
echo ""
echo -e "  ${BOLD}┌─────────────────────────────────────────────────┐${NC}"
echo -e "  ${BOLD}│  접속 방법                                       │${NC}"
echo -e "  ${BOLD}├─────────────────────────────────────────────────┤${NC}"
echo -e "  │                                                 │"
echo -e "  │  ${GREEN}VSCode Server (브라우저)${NC}"
echo -e "  │  URL: ${BOLD}${VSCODE_URL}${NC}"
echo -e "  │  비밀번호: 설정한 비밀번호                       │"
echo -e "  │                                                 │"
echo -e "  │  ${GREEN}SSM Session Manager (터미널)${NC}"
echo -e "  │  $SSM_CMD"
echo -e "  │                                                 │"
echo -e "  ${BOLD}└─────────────────────────────────────────────────┘${NC}"
echo ""
echo -e "  ${YELLOW}EC2 UserData 설치 완료까지 약 5-10분 소요됩니다.${NC}"
echo -e "  ${YELLOW}설치 로그: aws ssm start-session --target $INSTANCE_ID${NC}"
echo -e "  ${YELLOW}          cat /var/log/user-data.log${NC}"
echo ""
echo -e "  ${BOLD}IAM Role: $ROLE_NAME${NC}"
echo -e "  AdministratorAccess 추가:"
echo "    aws iam attach-role-policy \\"
echo "      --role-name $ROLE_NAME \\"
echo "      --policy-arn arn:aws:iam::aws:policy/AdministratorAccess"
echo ""
echo -e "  ${BOLD}스택 삭제:${NC}"
echo "    bash deploy.sh --delete $STACK_NAME"
echo ""
