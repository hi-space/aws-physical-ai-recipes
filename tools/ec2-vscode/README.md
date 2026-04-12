# EC2 VSCode Server

Public Subnet의 EC2에 code-server(VSCode)를 배포합니다.

## 아키텍처

```
User Browser (HTTP:8888)
  → EC2 (Public Subnet, Public IP)
      - code-server v4.110.0
      - Claude Code CLI + Extension
      - Kiro CLI
      - Docker, Node.js 20, Python3, AWS CLI v2
```

## 사전 조건

- AWS CLI 설치 및 자격 증명 설정
- 기존 VPC (미지정시 Default VPC 자동 사용)

## 빠른 시작

```bash
bash deploy.sh
```

대화형으로 다음을 입력합니다:
- **Stack Name** (필수) — 여러 사용자는 각자 다른 이름 사용
- **Password** (필수) — 8자 이상
- **Instance Type** — 기본값: m7i.2xlarge
- **EBS Size** — 기본값: 100GB
- **VPC 이름** — 미입력시 Default VPC 사용

## 수동 배포

```bash
aws cloudformation deploy \
  --stack-name my-vscode \
  --template-file cloudformation.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    VpcId=vpc-xxxxx \
    PublicSubnetId=subnet-xxxxx \
    InstanceType=m7i.2xlarge \
    VSCodePassword="MyPassword123" \
    EBSVolumeSize=100
```

## 접속 방법

### 브라우저 (VSCode Server)
배포 완료 후 출력되는 URL로 접속합니다. EC2 UserData 설치 완료까지 약 5-10분 소요됩니다.

```
http://<Public-IP>:8888
```

### SSM Session Manager (터미널)
```bash
aws ssm start-session --target <instance-id>
```

### 설치 로그 확인
```bash
# SSM으로 접속 후
cat /var/log/user-data.log
```

## 멀티 유저

각 사용자가 다른 Stack Name으로 배포하면 독립적인 EC2가 생성됩니다.

```bash
# 사용자 A
bash deploy.sh   # Stack Name: vscode-alice

# 사용자 B
bash deploy.sh   # Stack Name: vscode-bob
```

## IAM 권한 추가

기본으로 SSM + CloudWatch 권한만 부여됩니다. 필요시 추가 권한을 부여하세요.

```bash
# AdministratorAccess 추가
aws iam attach-role-policy \
  --role-name <stack-name>-VSCode-Role \
  --policy-arn arn:aws:iam::aws:policy/AdministratorAccess
```

## Claude Code + Bedrock 설정

EC2 배포 후 Claude Code를 Amazon Bedrock과 연동하려면 별도 설정이 필요합니다.

```bash
# SSM 또는 브라우저 터미널에서 실행
cd claude-code-setup

# 1. Bedrock 환경변수 설정
bash 01-setup-bedrock-env.sh
source ~/.bashrc

# 2. VS Code 확장 설정
bash 02-setup-vscode-settings.sh

# 3. 플러그인 + MCP 서버 설치 (선택)
bash 03-setup-plugins-and-mcp.sh

# 4. AWS Skills 설치 (선택)
bash 06-setup-aws-skills.sh
```

자세한 내용은 [claude-code-setup/README.md](claude-code-setup/README.md)를 참고하세요.

## 삭제

```bash
bash deploy.sh --delete <stack-name>
```

또는:
```bash
aws cloudformation delete-stack --stack-name <stack-name>
```
