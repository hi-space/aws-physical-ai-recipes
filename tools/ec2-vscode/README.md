# EC2 VSCode Server

CloudFront를 통해 HTTPS로 접속하는 EC2 기반 code-server(VSCode)를 배포합니다.

## 아키텍처

```
User Browser (HTTPS)
  → CloudFront (TLS termination)
    → EC2:8888 (Public Subnet, SG: CloudFront IP만 허용)
        - code-server v4.110.0
        - Claude Code CLI + Extension
        - Kiro CLI
        - Docker, Node.js 20, Python3, AWS CLI v2
```

## 사전 조건

- AWS CLI 설치 및 자격 증명 설정
- 기존 VPC (Public Subnet은 CloudFormation이 자동 탐색)

## 빠른 시작

```bash
bash deploy.sh
```

대화형으로 다음을 입력합니다:
- **Stack Name** (필수) — 여러 사용자는 각자 다른 이름 사용
- **Password** (필수) — 8자 이상, 확인 입력 포함
- **Instance Type** — 9개 옵션 중 번호로 선택 (기본값: m7i.2xlarge)
  - x86_64: m7i.2xlarge, m7i.xlarge, t3.2xlarge, t3.xlarge, t3.large
  - ARM64 Graviton: m7g.2xlarge, m7g.xlarge, t4g.2xlarge, t4g.xlarge
- **EBS Size** — 기본값: 100GB
- **VPC** — 리전 내 VPC 목록에서 번호로 선택

## 수동 배포

```bash
aws cloudformation deploy \
  --stack-name my-vscode \
  --template-file cloudformation.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    VpcId=vpc-xxxxx \
    InstanceType=m7i.2xlarge \
    VSCodePassword="MyPassword123" \
    EBSVolumeSize=100
```

## 접속 방법

### 브라우저 (VSCode Server)
배포 완료 후 출력되는 CloudFront URL로 접속합니다. EC2 UserData 설치 완료까지 약 5-10분 소요됩니다.

```
https://<xxxxxx>.cloudfront.net
```

### SSH (터미널)

로컬 PC에서 SSH 키 생성과 config 설정을 자동으로 수행하는 스크립트를 제공합니다.

```bash
# 로컬 PC에서 실행
bash ssh-client-setup/setup-ssh-client.sh <PUBLIC_IP>
```

스크립트 실행 후 출력되는 공개키 등록 명령어를 EC2 Instance Connect 브라우저 터미널에서 실행하면 바로 접속할 수 있습니다.

```bash
ssh isaaclab
```

자세한 내용은 [ssh-client-setup/README.md](ssh-client-setup/README.md)를 참고하세요.

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

# 1. Bedrock 환경변수 + VS Code 설정
bash 01-setup-bedrock-env.sh
source ~/.bashrc

# 2. 플러그인 + MCP 서버 설치
bash 02-setup-plugins-and-mcp.sh
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
