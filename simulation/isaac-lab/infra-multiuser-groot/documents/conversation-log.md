# 대화 기록: Isaac Lab CDK 멀티 사용자 지원 작업

날짜: 2026-04-09

## 주요 논의 및 결정 사항

### 1. Andy Jassy 2025 주주서한 요약
- "직선은 거짓말이었다" 테마
- 2025 실적: 매출 $717B (+12%), AWS $129B (+20%), 영업이익 $80B (+17%)
- 5대 전략: 변곡점 창출, 병렬 경로 추진, AI 과감 투자, 출발선 회귀, 꼬불꼬불한 길 견디는 문화

### 2. 동일 계정 멀티 사용자 동시 배포 문제 분석
- 스택 이름 충돌 (가장 큰 문제)
- ECR 리포지토리 `isaaclab-batch` 하드코딩으로 이미지 덮어쓰기
- GPU 인스턴스 할당량 소진
- VPC 할당량 (리전당 기본 5개)
- 리소스 태그 혼동

### 3. 인스턴스 타입 fallback 리스트 변경
- 기존: g6.12xlarge → g5.12xlarge → g6.xlarge → g5.xlarge
- 최종: g6.4xlarge → g6e.4xlarge → g6.12xlarge → g6e.12xlarge
- g5 계열 및 xlarge 제거 (Isaac Sim에 부적합)

### 4. 아키텍처 결정: 스택 분리 vs 사용자 구분
- 공유 VPC(2-스택 분리) 검토 → 복잡도 대비 이점 부족
- **결정: 현재 단일 스택 구조 유지 + userId context 추가**
- 이유: 워크숍 "원클릭 배포" 목적에 부합, 코드 변경 최소화

### 5. 멀티 사용자 지원 구현 (isaac-lab-infra-templates-multiuser)
변경 파일 4개:
- `bin/isaac-lab-app.ts`: userId context 추가, 유효성 검사, 스택 이름에 반영
- `lib/isaac-lab-stack.ts`: userId props, cdk.Tags.of(this).add('UserId'), ecrRepoName 분리
- `lib/constructs/dcv-instance.ts`: ecrRepoName props, UserData에 ECR_REPO_NAME 환경 변수
- `assets/userdata/isaac-lab.sh`: 하드코딩 isaaclab-batch → $ECR_REPO_NAME

### 6. VPC CIDR 파라미터화
- `-c vpcCidr=10.x.0.0/16`으로 사용자별 VPC 대역 분리 가능
- 서브넷 CIDR 자동 계산 (두 번째 옥텟 기반)
- EFS SG 인바운드도 vpcCidr 연동

### 7. 충돌 검증 완료
- IAM Role, Lambda, Secrets Manager, LogGroup, InstanceProfile: 전부 물리적 이름 미지정 → CloudFormation이 스택이름+논리ID+해시로 자동 생성
- `cdk synth` alice/bob 동시 생성 검증 통과
- ECR 리포지토리: isaaclab-batch-{userId}로 분리

### 8. Batch 단일 AZ 제약 문서화
- 프라이빗 서브넷 + EFS Mount Target이 단일 AZ에만 존재
- DCV: 배포 시점 AZ Selector가 capacity 확인 → 문제 없음
- Batch: 실행 시점에 해당 AZ capacity 부족 시 fallback 불가
- 대응: 재시도, 다른 리전 재배포, 또는 S3 체크포인트 전환

### 9. 분산 학습 체크포인트 공유
- PyTorch DDP: AllReduce로 그래디언트 동기화, rank 0만 체크포인트 저장
- EFS로 충분 (수십~수백 MB, 에포크 단위 저장)
- 멀티 AZ 필요 시 S3 대안

### 10. CloudShell 배포 가이드
- nohup &로 백그라운드 실행 (세션 20분 타임아웃 대응)
- 재접속 후 tail -f deploy.log 또는 CloudFormation 콘솔 확인

### 11. CDK Bootstrap
- 계정+리전당 1회, 관리자가 사전 실행
- 동시 실행 금지 (CDKToolkit 스택 충돌)

## 생성된 파일 목록

### 코드 변경 (isaac-lab-infra-templates-multiuser/)
- `bin/isaac-lab-app.ts` — userId, vpcCidr context 추가
- `lib/isaac-lab-stack.ts` — userId props, 태그, ecrRepoName
- `lib/constructs/dcv-instance.ts` — ecrRepoName props
- `lib/constructs/networking.ts` — vpcCidr 파라미터화
- `lib/constructs/efs-storage.ts` — vpcCidr 연동
- `lib/constructs/az-selector.ts` — fallback 리스트 변경
- `assets/userdata/isaac-lab.sh` — ECR_REPO_NAME 변수화
- `README.md` — 멀티 사용자 섹션, Batch AZ 제약 추가

### 문서 (isaac-lab-infra-templates-multiuser/documents/)
- `workshop-admin-checklist.md` — 관리자 사전 체크리스트
- `batch-distributed-training.md` — Batch 분산 학습 가이드

## 사용법 요약

```bash
# 관리자: 사전 1회
cdk bootstrap aws://$ACCOUNT_ID/$REGION

# 참가자: 각자 배포
cdk deploy -c userId=alice -c vpcCidr=10.1.0.0/16

# CloudShell에서
nohup npx cdk deploy -c userId=alice -c vpcCidr=10.1.0.0/16 --require-approval never > deploy.log 2>&1 &

# 정리
cdk destroy -c userId=alice
```

## 남은 작업
- 실제 AWS 계정에서 배포 1회 검증
- UserData 완료 및 DCV 접속 확인
- cdk destroy 정리 확인
