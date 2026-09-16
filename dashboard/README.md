# Physical AI Dashboard

Physical AI 워크숍의 데이터 준비, 학습, 평가, 시각화와 운영을 하나의 웹 화면으로 연결합니다. **Next.js 16.3.5**, Cognito, ALB를 사용하고 HyperPod EKS, SageMaker, FSx for Lustre, S3와 연결합니다.

NVIDIA OSMO의 연구자 작업 흐름을 AWS 서비스로 구현합니다. OSMO API 전체의 호환성을 주장하지 않습니다. 승인된 범위와 기능별 구현·검증 상태는 [설계](../docs/designs/2026-09-16-physical-ai-dashboard.md)와 [기능 증거](../docs/reports/2026-09-16-feature-evidence.md)를 확인하세요. GPU 이미지가 빌드되었다는 사실과 실제 모델·로봇 검증은 구분합니다.

## 연구자 사용 흐름

1. Cognito로 로그인하고 **연구 프로젝트**를 선택합니다. 관리자가 연결한 자원 풀과 프로젝트 권한을 사용합니다.
2. **워크플로 → 새 실행**에서 레시피를 선택합니다. 데이터셋 버전, seed, 학습량과 평가 조건을 입력하고 검증한 뒤 제출합니다. 필요하면 YAML을 편집하고 새 템플릿 버전으로 저장할 수 있습니다.
3. 실행 상세에서 DAG, 작업별 상태, 로그, 이벤트와 지표를 확인합니다. 터미널·파일 접속 및 Jupyter/code-server/TensorBoard는 **세션**에서 엽니다.
4. 결과가 `READY`가 되면 **데이터셋**에서 확인하거나 **모델**에 체크포인트를 등록합니다. 평가 결과의 checkpoint·정규화 통계·입력 버전이 맞아야 품질 판정을 기록할 수 있습니다.
5. HF/NGC 등 외부 자격증명은 **접근 관리**에 등록합니다. YAML에는 값 대신 등록된 참조를 사용합니다. CLI 토큰도 이 화면에서 범위와 만료를 지정해 발급·폐기합니다.

짧은 학습의 성공, 모델 로드 확인, 시뮬레이터 평가, 실제 로봇 검증은 서로 다른 결과입니다. Smoke 통과만으로 로봇 성능이 승인되지는 않습니다.

## 화면과 실행 기능

| 화면 | 기능 |
|---|---|
| 워크플로 | 직렬·병렬 DAG, JobSet 그룹/barrier, 재시도·checkpoint, 검색·페이지 이동, 복제·취소·대량 취소, 불변 실행 구성 |
| 데이터셋 | 업로드 중 `PENDING`, 객체 버전·체크섬을 검증한 `READY`, 태그·파일 탐색·입출력 계보 |
| 모델 | 체크포인트와 정규화 통계 고정, 평가 JSON/영상, 평가 이력과 명시적 품질 승인 |
| 지표·실험 | 프로젝트별 AMP/MLflow 지표, 동일 step 축 실험 비교, 공급자 오류와 실제 빈 데이터를 구분 |
| 세션 | 별도 HTTPS origin의 터미널·포트·파일 브라우저, 관리형 작업 공간, 소유권·만료·폐기 확인 |
| 파이프라인 | GR00T SageMaker 파이프라인의 프로젝트별 시작·단계·로그·중단, 중복 요청 방지 |
| 큐·컴퓨트 | Kueue admission·할당량·차용량·대기 사유, HyperPod 노드와 관리자 scale 제어 |
| 엣지 | 등록된 대상·고정 모델/컴포넌트 기반 배포 계획, 실제 완료 확인, rollback, 장치 lease, 검증 유형을 구분한 benchmark |
| 빌드 | 등록된 CodeBuild 작업 실행·상태·로그 위치, ECR 이미지와 소스 추적 |
| 프로젝트·접근 관리 | Cognito 주체별 프로젝트 권한, 개인/공유 credential 참조, 범위·만료·폐기가 있는 API 토큰 |

공유 워크숍 DCV 호스트는 관리자용 연결입니다. 일반 작업 앱은 대시보드와 별도 origin에서 실행합니다. 기존 Slurm 클러스터는 운영 정보를 조회·관리하며 이 대시보드의 DAG 제출 대상은 EKS입니다.

## 제어 계층

웹 API, 작업 실행기, 세션 게이트웨이를 **서로 다른 ECS Fargate 서비스와 IAM 역할**로 실행합니다.

- DynamoDB는 실행·시도·소유권·lease·발행 결과의 원장입니다. 새 요청에는 idempotency key를 사용할 수 있습니다.
- Step Functions Standard와 SQS는 전체 실행 수명과 복구 요청을 연결합니다. 실행기가 중복 메시지와 중단된 시도를 조정합니다.
- EKS 작업은 프로젝트 namespace와 Kueue queue를 서버에서 결정합니다. 그룹은 JobSet과 작업 시작 barrier를 사용합니다.
- 작업에 필요한 데이터는 고정된 S3 manifest에서 준비합니다. FSx 결과는 내구성 있는 S3 버전으로 검증한 뒤 게시합니다.
- 터미널과 앱은 일회용 접속 ticket을 세션 origin의 쿠키로 교환합니다. token으로 만든 접속은 token 폐기·만료·권한 변경도 다시 검사합니다.
- 프로젝트 작업은 제한된 파일 경로와 non-root 실행을 사용합니다. 노드 metadata/Pod Identity 접근을 차단하는 정책과 시작 확인 단계가 포함됩니다.

실행 의미와 제한: [workflow](web/src/server/workflow/README.md), [runtime](runtime/README.md), [레시피](recipes/README.md), [세션](web/src/server/gateway/README.md), [CLI](cli/README.md), [엣지](edge/README.md).

## 설치·업데이트

필요 조건: 배포된 HyperPod EKS 스택, 제어 서비스가 사용할 private subnet, 제어 가능한 Route 53 public zone, Docker, Node.js 22, CDK bootstrap 및 배포용 AWS 권한.

```bash
cd dashboard/infra
npm ci
npx cdk deploy \
  -c domainName=physical-ai.example.com \
  -c hostedZoneId=Z0123456789ABC \
  -c hostedZoneName=example.com \
  -c extendedImages=true
```

기본 이미지는 MuJoCo, Isaac Lab, ROS 2와 작업 공간입니다. `extendedImages=true`는 GR00T/OpenPI도 준비합니다. 첫 GPU 이미지 빌드·업로드와 ACM 발급에는 시간이 걸릴 수 있습니다. Cosmos/LeIsaac은 별도 모델·GPU·장면 자산 조건을 충족해야 합니다. 필요한 이미지가 없으면 제출 전에 오류를 표시합니다.

기존 웹 내부 실행기를 별도 실행기로 전환하는 **첫 업데이트에만** `-c controllerSplitMigration=true`를 추가합니다. 이전 실행기가 종료된 뒤 새 서비스를 시작합니다. 이후 업데이트에서는 이 옵션을 제거합니다.

EKS add-on/RBAC 준비는 `infra/ops/apply_addons.py` 또는 대시보드의 등록된 운영 CodeBuild 작업으로 수행합니다. 기존 CNI 설정 전체를 덮어쓰지 않고 필요한 network-policy 기능과 대시보드용 역할·정책을 적용합니다.

출력에는 `DashboardUrl`, `ArtifactBucketName`, 실행기·게이트웨이 서비스와 Step Functions ARN이 포함됩니다. 초기 관리자 자격증명은 Secrets Manager의 `physical-ai-dashboard/<accountId>/admin`에 저장됩니다. 일반 사용자와 프로젝트 권한은 웹 관리자 화면에서 관리합니다.

부모 HyperPod/Isaac Lab 스택은 이 업데이트에서 재배포하지 않습니다. 대시보드의 데이터 테이블·사용자 풀·아티팩트 버킷 등 상태 리소스에는 보존 정책이 적용되어 있습니다. 스택 삭제를 데이터 삭제로 간주하지 마세요.

## 개발·검증

```bash
cd dashboard/web
npm ci
npm test
npm run typecheck
npm run build
npm run build:services
```

`AUTH_MODE=dev npm run dev`는 로컬 개발용이며 production/ECS에서는 사용할 수 없습니다. 실제 AWS 연결에 사용하는 환경 변수는 `web/src/server/config.ts`와 `infra/lib/env-contract.ts`에 정의되어 있습니다.

Cognito를 통한 실제 테스트에는 `DASHBOARD_URL`, `DASHBOARD_USER`, `DASHBOARD_PASSWORD`를 테스트 프로세스에 주입합니다. 자격증명을 파일이나 로그에 남기지 마세요.

```bash
npx playwright test e2e/smoke.spec.ts --workers=1
DASHBOARD_RESEARCHER_LIVE=1 npx playwright test e2e/researcher.spec.ts --workers=1
```

연구자 테스트는 실제 CPU 작업과 S3 산출물, 데이터셋 준비·재사용, HTTPS 터미널·파일 전송을 검사합니다. 자신의 세션과 미완료 작업만 정리하고 완료된 증거는 남깁니다. 하드웨어·모델 접근 조건이 충족되지 않은 GPU/로봇 기능을 이 테스트의 성공으로 대신하지 않습니다.

## 디렉터리

- `web/`: UI, API, 실행기·게이트웨이, AWS/Kubernetes adapter, 단위·브라우저 테스트
- `infra/`: CDK, 스택 탐색, 운영 add-on 준비
- `runtime/`: 작업 barrier, epoch 확인, 입출력·checkpoint 및 파일 브라우저
- `images/`, `recipes/`: 모델·시뮬레이터 이미지와 실제 연구 워크로드
- `session-image/`, `dcv-agent/`: 작업 공간 이미지와 기존 DCV 연동
- `cli/`, `edge/`: 프로그램 접속·파일 동기화, 엣지 실행·benchmark 및 가상 장치 검증
