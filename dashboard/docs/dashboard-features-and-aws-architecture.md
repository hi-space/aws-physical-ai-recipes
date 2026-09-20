# Physical AI Dashboard — 기능별 동작과 AWS 백엔드 매핑

작성 기준: 2026-09-18, 배포 `https://physical-ai.hi-yoo.com` (CDK 스택 `PhysicalAiDashboard-913524902871`, us-east-1), 브랜치 `feat/hyperpod-dashboard`.
스크린샷은 관리자(`admin`) 계정으로 한국어 UI에서 캡처했습니다. 다이어그램은 `docs/diagrams/`에 draw.io 원본(`physical-ai-dashboard-features.drawio`, 9페이지)과 PNG(XML 내장, draw.io에서 재편집 가능)로 있습니다.

> 이 문서는 **현재 코드와 배포 상태**를 기술합니다. 2026-09-18 [아키텍처 단순화 설계](../../docs/designs/2026-09-18-dashboard-architecture-simplification.md)에 따라 Step Functions·SQS·callbacks 테이블은 제거되었고 WAF·알람·아티팩트 수명 주기가 적용되었습니다.

---

## 목차

1. [전체 아키텍처](#1-전체-아키텍처)
2. [로그인·인증·권한](#2-로그인인증권한)
3. [홈(Overview)](#3-홈overview)
4. [실행(Runs) — 목록·새 실행·실행 상세](#4-실행runs--목록새-실행실행-상세)
5. [데이터셋](#5-데이터셋)
6. [모델·평가](#6-모델평가)
7. [실험 비교 (MLflow)](#7-실험-비교-mlflow)
8. [SageMaker 학습 (파이프라인)](#8-sagemaker-학습-파이프라인)
9. [시뮬레이션·개발 세션 (DCV 포함)](#9-시뮬레이션개발-세션-dcv-포함)
10. [컴퓨트](#10-컴퓨트)
10a. [리소스](#10a-리소스)
11. [대기열·할당량](#11-대기열할당량)
12. [Kubernetes 작업](#12-kubernetes-작업)
13. [메트릭](#13-메트릭)
14. [파일 (S3·FSx)](#14-파일-s3fsx)
15. [사용량·비용](#15-사용량비용)
16. [프로젝트·구성원](#16-프로젝트구성원)
17. [자격증명·API 토큰](#17-자격증명api-토큰)
18. [이미지·실행 환경](#18-이미지실행-환경)
19. [디바이스·배포 (엣지)](#19-디바이스배포-엣지)
20. [자동화·웹훅](#20-자동화웹훅)
21. [환경 빌드](#21-환경-빌드)
22. [백엔드 연결](#22-백엔드-연결)
23. [플랫폼 설정 (관리자)](#23-플랫폼-설정-관리자)
24. [AWS 서비스별 사용 API 총괄표](#24-aws-서비스별-사용-api-총괄표)
25. [환경 변수 계약과 IaC](#25-환경-변수-계약과-iac)
26. [알려진 제한과 설계-배포 차이](#26-알려진-제한과-설계-배포-차이)

---

## 1. 전체 아키텍처

![전체 아키텍처](diagrams/00-전체-아키텍처.drawio.png)

### 구성 요소

| 계층 | 리소스 | 역할 |
|---|---|---|
| 진입 | Route 53 (`physical-ai.hi-yoo.com`, `*.apps.physical-ai.hi-yoo.com`), ACM 인증서 | 대시보드 도메인과 세션 호스트 와일드카드를 같은 ALB로 연결 |
| 인증 | Cognito User Pool `us-east-1_YpnKXG6LG`, Managed Login v2(다크 테마), 그룹 `admins`/`researchers`/`viewers` | ALB의 `authenticate-cognito` 기본 동작이 로그인 처리, 앱 코드에는 로그인 화면이 없음 |
| 부하 분산 | ALB :443 | 기본 → web(:3000); `Host *.apps.*` → gateway(:3002); `/api/health`, `/api/logout`, `/api/v1/*`는 Cognito 우회 |
| 컴퓨트 | ECS Fargate 클러스터 `physical-ai-dashboard-<acct>`: **web**(512 CPU/1 GiB), **controller**(2048 CPU/4 GiB), **gateway**(256 CPU/512 MiB) | 세 서비스는 같은 웹 이미지를 서로 다른 command로 실행. 기존 HyperPod VPC의 private subnet에 배치. Cloud Map으로 `controller.<prefix>.internal` 이름 제공 |
| 원장 | DynamoDB 단일 테이블 `physical-ai-dashboard-913524902871-us-east-1`(pk/sk, GSI `gsi1`, TTL) | 프로젝트·워크플로·태스크·데이터셋 버전·세션·감사·임대·outbox 등 모든 상태 |
| 저장 | S3 `physicalaidashboard-…-orchestrationartifacts…`(버전 관리, 아티팩트 스냅샷), `hyperpod-eks-data-…`(FSx DRA 미러), `groot-sm-artifacts-…`(SageMaker 산출물) | 게시된 결과는 VersionId·SHA-256이 고정된 manifest로만 읽음 |
| 오케스트레이션 | controller(Fargate) 5초 reconcile 루프 + DynamoDB 임대·outbox | 워크플로 수명은 DynamoDB 상태와 Kubernetes Job `activeDeadlineSeconds`가 집행. 외부 큐·상태 머신 없음 |
| 실행 기반 | SageMaker HyperPod EKS `hyperpod-eks-913524902871`(cpu-c5-4x ×2, gpu-g5-8x ×1), Kueue, JobSet, EKS Pod Identity, FSx for Lustre `fs-042f63b1f254c0087`(1.2 TiB) | 모든 레시피 실행은 프로젝트 네임스페이스(`hyperpod-ns-team-a`)의 Kubernetes Job/JobSet |
| ML 서비스 | SageMaker Pipelines `groot-sm-finetuning-<acct>`, Model Registry `groot-sm-models-<acct>`, MLflow 추적 서버 `groot-mlflow-<acct>`, ComputeQuota | GR00T 파이프라인·모델 승인·실험 비교 |
| 관측 | Amazon Managed Service for Prometheus `ws-25f09b6a-…`, CloudWatch Logs(`/aws/ecs/<prefix>`, `/aws/sagemaker/Clusters/*`, `/aws/sagemaker/TrainingJobs`) | 메트릭 화면은 AMP를 SigV4로 직접 질의 |
| 기타 | ECR(워크로드 이미지), CodeBuild(운영·소스 빌드), SSM Parameter Store(자격증명·웹훅 secret), Secrets Manager(admin 초기 계정·runtime HMAC 키·DCV SSO), Cost Explorer, IoT Core/Greengrass, EC2 g5.4xlarge(Isaac Sim + DCV) | 각 설정 화면이 사용 |

### 요청 흐름 요약

1. 브라우저가 `https://physical-ai.hi-yoo.com`에 접근하면 ALB가 Cognito Hosted UI로 302 리디렉션하고, 로그인 후 ALB 세션 쿠키(12시간)와 `x-amzn-oidc-*` 헤더를 web에 전달합니다.
2. web(Next.js 16)이 헤더의 JWT를 검증해 역할을 정하고 API를 처리합니다. AWS SDK 호출은 ECS 태스크 역할로, Kubernetes 호출은 EKS `DescribeCluster` + STS 서명 토큰으로 수행합니다.
3. 상태 변경은 DynamoDB에 기록되고, 장기 작업(레시피 실행·데이터셋 확정·파이프라인 시작·웹훅·스케일링)은 controller 워커 루프가 처리합니다.
4. 세션(Jupyter·터미널·실시간 보기·DCV)은 별도 origin `https://<session-id>.apps.physical-ai.hi-yoo.com`으로 gateway를 통해 Pod나 EC2에 연결됩니다.

---

## 2. 로그인·인증·권한

![로그인](screenshots/00-login-cognito.png)

![로그인·인증·권한 다이어그램](diagrams/01-로그인-인증-권한.drawio.png)

### 인증 모드

- **`alb`** — ALB `authenticate-cognito` 액션(Cognito Hosted UI 리디렉션), 12시간 ALB 세션 쿠키, HTTPS 도메인 배포(세 도메인 context 필수)
- **`cognito`** — 앱 `/login` 페이지 → Cognito `InitiateAuth`(USER_PASSWORD_AUTH/SRP) → `pai-auth` HS256 쿠키(access 1시간 자동 갱신, refresh 30일, 로그아웃 시 `RevokeToken`), 비밀번호 변경 챌린지 지원, 도메인 없는 HTTP 배포(세션 게이트웨이는 ALB :8080 경로 모드 — §9 참조)

### 동작 과정

1. **ALB `authenticate-cognito`**: 인증되지 않은 요청은 `https://physical-ai-913524902871.auth.us-east-1.amazoncognito.com/login`(Managed Login v2, 대시보드와 같은 다크 팔레트)으로 보내고, 코드 교환 후 `AWSELBAuthSessionCookie`를 발급합니다.
2. **web `src/proxy.ts`**(Next.js 미들웨어)가 `x-amzn-oidc-data`(ES256)를 ELB 공개키(`public-keys.auth.elb.us-east-1.amazonaws.com/<kid>`)로 검증하고 signer가 `ALB_ARN`과 같은지, issuer가 사용자 풀인지 확인합니다. `x-amzn-oidc-accesstoken`은 Cognito JWKS로 검증해 `cognito:groups`를 읽습니다. 검증 결과는 신뢰 헤더 `x-pai-user/subject/email/role/project`로 주입되며, 클라이언트가 보낸 `x-pai-*`는 제거됩니다.
3. **역할**: 플랫폼 역할은 `viewer < researcher < admin`(Cognito 그룹 `researchers`, `admins`). 프로젝트 역할은 DynamoDB `PROJECT#<id>` 멤버십의 `viewer / researcher / project-admin`. 관리자는 모든 프로젝트에서 `project-admin`으로 취급됩니다.
4. **모든 API는 `route(minRole, handler, {audit})`** 래퍼를 지나며, 브라우저 변경 요청은 same-origin을 강제하고 non-GET은 `AUDIT` 파티션에 90일 TTL로 기록됩니다.
5. **CLI/API 토큰**: `Authorization: Bearer pai_<43자>`로 `/api/v1/*`(ALB가 Cognito를 우회)에 호출하면 토큰의 SHA-256 해시를 DynamoDB에서 조회하고, 발급 시 결정된 프로젝트·scope 안에서만 `/api/*`로 재작성합니다. 매 요청마다 Cognito `AdminGetUser`/`AdminListGroupsForUser`를 다시 확인해 그룹 탈퇴가 즉시 반영됩니다.
6. **로그아웃**: 사이드바 버튼 → `POST /api/auth/logout`(gateway 세션 회수, 감사 기록) → `GET /api/logout`(ALB 쿠키 삭제, Cognito `/logout`으로 302).

### AWS 매핑

| 기능 | AWS 서비스 · API |
|---|---|
| 로그인 화면·세션 | Cognito User Pool(Hosted UI, 앱 클라이언트 `alb`), ALB authenticate-cognito 액션 |
| JWT 검증 | ELB 공개키 엔드포인트(HTTPS), Cognito JWKS |
| 초기 관리자 | Secrets Manager `physical-ai-dashboard/<acct>/admin`, CDK 커스텀 리소스 `AdminCreateUser`/`AdminSetUserPassword`/`AdminAddUserToGroup` |
| API 토큰·감사 | DynamoDB `API_TOKEN#<sha256>`, `PROJECT#<p>/TOKEN#…`, `AUDIT`; Cognito `AdminGetUser`, `AdminListGroupsForUser` |
| 권한 경계 | IAM 태스크 역할 3개(web/controller/gateway), EKS access entry 그룹 `physical-ai:web|controller|gateway` |

---

## 3. 홈(Overview)

![홈 상단](screenshots/01-overview-viewport.png)

전체 페이지: [01-overview.png](screenshots/01-overview.png)

### 화면 구성과 데이터 출처

| 카드 | 표시 내용 | 데이터 출처 |
|---|---|---|
| 워크플로 | 총 실행 수·상태별 개수 | DynamoDB `WF#*/META` Scan(최대 200) 후 프로젝트 필터 |
| 할당 가능한 GPU · 평균 사용률 | 노드 allocatable GPU 합, `avg(DCGM_FI_DEV_GPU_UTIL)` | Kubernetes `/api/v1/nodes`, AMP instant query |
| 준비된 Kubernetes 노드 | Ready/전체 | Kubernetes API |
| 대기열 대기 작업 (Kueue) | pending/admitted | Kueue `clusterqueues`, `workloads` CRD |
| AWS 계정 전체 비용 (최근 30일) | **관리자만**, 서비스별 상위 10개 + 추이 | Cost Explorer `GetCostAndUsage`(DAILY, UnblendedCost, GROUP BY SERVICE), 1시간 캐시 |
| 최근 실행 / 클러스터 / 최근 이벤트 | 실행 8건, HyperPod 클러스터 2개(EKS·Slurm)와 인스턴스 그룹 현재/목표, 이벤트 15건 | DynamoDB, SageMaker `ListClusters`/`DescribeCluster`/`ListClusterNodes` |
| **이 배포의 AWS 아키텍처** | 데이터·컴퓨트·학습·시뮬레이션·엣지·플랫폼 6개 영역의 실제 리소스 상태와 콘솔 링크 | `GET /api/architecture`: S3 `HeadBucket`, FSx `DescribeFileSystems`·`DescribeDataRepositoryAssociations`, SageMaker `DescribeCluster`·`DescribePipeline`·`DescribeMlflowTrackingServer`, EKS `DescribeCluster`, Kueue ClusterQueue, EC2 `DescribeInstances`, IoT `DescribeThingGroup`; Cognito·DynamoDB·CloudWatch·AMP는 식별자만 표시(60초 캐시) |
| Run controller | Running / Lease held | DynamoDB `SYS/LEASE#CONTROLLER` |

빠른 링크(데이터셋 → GR00T 파이프라인 → 실험 비교 → 세션 → 컴퓨트 → 메트릭)는 `features` 플래그(eks/slurm/amp/mlflow/pipeline/dcv/fsx/edge)로 감춰지며, 플래그는 환경 변수 존재 여부에서 파생됩니다. 화면의 모든 숫자는 Describe/Query 응답값이고 코드에 하드코딩된 인프라 값은 없습니다(2026-09-18 사실 기반 규칙).

---

## 4. 실행(Runs) — 목록·새 실행·실행 상세

![실행 다이어그램](diagrams/02-실행-워크플로.drawio.png)

### 4.1 실행 목록

![실행 목록](screenshots/02-workflows-list.png)

- `GET /api/workflows?page&status&q&cursor`를 5초 주기로 폴링. 상태 필터·검색·커서 페이지네이션(200건 이상 미매칭이면 409 `workflow_search_incomplete`).
- 행 동작(연구자 + 프로젝트 쓰기 권한): 중지(`POST /:id/cancel`), 재시도(`POST /:id/retry`), 삭제(`DELETE /:id`, 소유자·종료 상태), 다중 선택 일괄 취소(`POST /bulk-cancel`).
- 비관리자는 자동으로 선택 프로젝트 범위에 갇힙니다.

### 4.2 새 실행 (3단계 마법사)

| 1단계 레시피 선택 | 2단계 입력 설정 | 3단계 YAML 및 실행 |
|---|---|---|
| ![](screenshots/04-workflow-new.png) | ![](screenshots/04b-workflow-new-inputs.png) | ![](screenshots/04c-workflow-new-yaml.png) |

1. **레시피 선택**: `GET /api/templates`(15초)로 내장 레시피를 카테고리(데이터 준비·학습·평가·시뮬레이션·사용자 레시피)와 태그(`fsx`/`gpu`/`mlflow`)로 표시. 예: `GR00T VLA 파이프라인: 데이터 → 파인튜닝 → 평가 (GPU DAG)` v2, `MuJoCo 학습 → 평가 (CPU)` v7. 상단 "CPU 학습 → 평가 시작"은 `mujoco-pipeline`에 `steps=512`, `num_envs=1`, `episodes=20`을 미리 채운 링크입니다. 선택한 버전은 작성 중 자동으로 최신으로 바뀌지 않습니다.
2. **입력 설정**: 파라미터 폼(이미지 URI는 `MUJOCO_IMAGE_URI` 등 환경 변수에서 고정 값), HF 데이터셋 ID/revision, 기본 모델, seed/steps/batch, 평가 trajectory 수, 언어 지시, 실행 네임스페이스(선택 프로젝트가 결정), 우선순위(Kueue `WorkloadPriorityClass`: training/inference/background). 자격증명은 값 대신 `ref`를 선택합니다. 관리자에게는 태스크별 실행 프로필 선택이 추가됩니다.
3. **YAML 및 실행**: 편집 가능한 YAML(1 MiB 제한) → 디바운스 `POST /api/workflows/validate` → **이미지 사전 검사 카드**(ECR digest 고정, 미승인 이미지면 422 `image_preflight_blocked`, 검토 필요면 428 후 사용자 확인) → `POST /api/workflows`(`idempotency-key` 헤더). "레시피로 저장"은 `POST /api/templates`, "YAML 다운로드", 복제는 `sessionStorage`로 YAML 전달.

### 4.3 실행 상세 — 7개 탭

| DAG | 작업 | 로그 |
|---|---|---|
| ![](screenshots/03-workflow-detail-dag.png) | ![](screenshots/03b-workflow-detail-tasks.png) | ![](screenshots/03c-workflow-detail-logs.png) |

| 이벤트 | 메트릭 | 산출물 |
|---|---|---|
| ![](screenshots/03d-workflow-detail-events.png) | ![](screenshots/03e-workflow-detail-metrics.png) | ![](screenshots/03f-workflow-detail-artifacts.png) |

스펙 탭: [03g-workflow-detail-spec.png](screenshots/03g-workflow-detail-spec.png) (제출된 불변 YAML 전체)

| 탭 | 동작 | 백엔드 |
|---|---|---|
| **DAG** | React Flow 좌→우 계층 그래프. 단계 카드(번호·상태·소요 시간·GPU/CPU·시도), 데이터셋 입력은 점선 pill, 건너뛰는 의존성은 위로 호를 그려 중간 노드를 가리지 않음. 상단 단계 스트립·←→ 키로 이동, 노드를 선택하면 오른쪽 패널에 시간·시도·종료 코드·리소스·이미지·입력(이전 작업 클릭 이동)·게시된 출력과 로그/산출물 탭 바로가기 표시. 선택과 무관한 노드는 흐리게, 실행 중 단계로 들어가는 선은 흐르는 점선 | DynamoDB `WF#<id>/META`, `TASK#` |
| **작업** | 태스크·시도별 상태, 이미지 digest, 요청 CPU/GPU, Pod 이름 | DynamoDB + Kubernetes Job/Pod 조회 |
| **로그** | 태스크의 현재 Pod를 Kubernetes API에서 읽어 JSON 스냅샷(`tail` ≤5,000줄) 또는 SSE(`follow=1`, 55초 연결, `Last-Event-ID`=타임스탬프로 재접속)로 표시. 시도·멤버·컨테이너 선택. Pod 삭제 후에는 `pod-gone` 안내만 표시 | Kubernetes `pods/<name>/log`(`timestamps`, `sinceTime`). 대시보드는 로그를 저장하지 않음. redaction은 시도별 불변 Secret 기준 |
| **이벤트** | 대시보드 이벤트(TaskRunning·DatasetPublished…) + Kubernetes 네임스페이스 이벤트(`wf-<id>-*` 접두) | DynamoDB `EVENT#`, K8s `/api/v1/namespaces/<ns>/events` |
| **메트릭** | Pod 단위 GPU util/mem(DCGM), CPU/mem(cAdvisor) 시계열 | AMP `query_range`(SigV4 `aps`), `features.amp`일 때만 |
| **산출물** | 태스크가 게시한 READY 버전의 고정 manifest를 읽어 이미지·영상은 갤러리(예: `plots/traj_*.jpeg`, LeRobot 영상), JSON·텍스트는 인라인, 가중치는 다운로드(presigned GET 300초, VersionId 고정). manifest 없는 구버전 출력은 사유만 표시 | `GET /api/workflows/:id/artifacts` → S3 아티팩트 버킷 `projects/<p>/datasets/<name>/versions/vN/manifest.json` |
| **스펙** | 제출 YAML·해시·템플릿 버전 | DynamoDB |

상단 동작: 재시도 / 복제 / YAML 내보내기(`GET /:id/export`) / 삭제. 하단 **작업 결과와 접속** 패널은 태스크를 골라 TensorBoard(완료된 학습도 가능), 터미널, 작업 파일, **실시간 보기**를 세션으로 여는 진입점이며(§9), **실행 사용량**은 요청 CPU/GPU 시간 기반 CPU-hour / GPU-hour 통계입니다(§15).

### 4.4 제출부터 게시까지의 백엔드 흐름

1. `POST /api/workflows`: 데이터셋 버전을 URI·FSx 경로·manifest 해시로 고정(`snapshotDataset`), 이미지 pin 검증, `WF#<id>` 기록(멱등 키는 프로젝트+사용자 범위).
2. controller(Fargate)가 5초마다 미완료 워크플로를 임대(`WF#<id>/LEASE`) 아래에서 reconcile하며 DAG를 컴파일합니다. 태스크는 `batch/v1 Job` 또는 그룹형 `jobset.x-k8s.io/v1alpha2 JobSet`으로 생성되고 `kueue.x-k8s.io/queue-name=<ns>-localqueue`, priority-class 라벨, FSx PVC subPath(`projects/<p>/…`), 서비스 계정 `pai-workflow`(EKS Pod Identity), non-root, NetworkPolicy(IMDS/Pod Identity egress 차단)를 갖습니다. Pod는 Cloud Map 이름으로 controller의 `/runtime/*`(HMAC capability 토큰)에 heartbeat와 결과를 보고합니다.
3. 완료·알림 같은 후속 작업은 `WF#<id>/OUT#<kind>` outbox 항목으로 기록되고 controller가 전달 성공 시 `deliveredAt`을 남깁니다.
4. 태스크 완료 시 controller가 FSx `DescribeDataRepositoryAssociations`로 `/fsx/checkpoints/...`에 대응하는 S3 접두사를 찾고 `CreateDataRepositoryTask(EXPORT_TO_REPOSITORY)`를 실행합니다. 이후 S3 데이터 버킷의 객체를 스트리밍 SHA-256으로 검증하며 아티팩트 버킷으로 복사(`CopyObject`/`UploadPartCopy`)하고 `manifest.json`을 써서 `publishDatasetVersion`(READY)합니다. 이 게시 단계는 controller CPU에 묶여 있어 24 GB 규모 checkpoint는 수십 분이 걸립니다.
5. 종료 시 SNS 알림(관리자 `notifyOn` 설정)과 프로젝트 웹훅 전달을 큐에 넣습니다(§20).

**실시간 보기(live: true)**: 컴파일러가 신뢰 이미지의 MJPEG 사이드카(포트 `pai-live`/8090)를 붙이고 `PAI_LIVE_DIR`을 주입, 레시피가 `frame.jpg`를 원자적으로 갱신하면 상세 화면이 port-forward 세션을 만들어 iframe으로 재생합니다(실행 소유자·RUNNING 태스크만).

---

## 5. 데이터셋

![데이터셋 다이어그램](diagrams/03-데이터셋.drawio.png)

| 목록 | 상세 |
|---|---|
| ![](screenshots/05-datasets-list.png) | ![](screenshots/05b-dataset-detail.png) |

### 화면

- **목록**: 리소스 스트립(데이터 버킷 S3 `hyperpod-eks-data-…`, FSx `fs-042f…`, 마운트 이름)과 데이터 출처(`DynamoDB dataset records · S3 ListObjectsV2 · HeadObject`). 통계(데이터셋 46 · 전체 버전 48 · 레시피에서 생성), 검색, **새 데이터셋**(이름·설명·태그·포맷), **HF에서 가져오기**(`hf-dataset-import` 레시피로 이동), "이전 개인 데이터 보기" 체크박스(legacy 항목).
- **상세**: 버전 목록(상태 PENDING/READY, S3 URI, FSx 경로, 생산 실행 링크), **새 버전**(직접 업로드 또는 S3 URI import, include/exclude 접두사), **검증 및 버전 확정**, 크기 새로 고침, 태그 편집, 삭제(참조된 버전은 거부), 파일 브라우저(고정 manifest 기반)와 파일별 다운로드, **업로드 영역**(PENDING 버전만), 계보 카드(생산 실행·소비 실행).

### PENDING → READY 동작

1. `POST /api/datasets/:name/versions` → DynamoDB `DS#<name>/V#000001` `state=PENDING`, 스테이징 접두사 `s3://hyperpod-eks-data-…/datasets/<name>/v<N>/`.
2. **브라우저 멀티파트 업로드**: `POST …/uploads`가 S3 `CreateMultipartUpload(ChecksumAlgorithm=SHA256, ChecksumType=COMPOSITE)`를 만들고, 브라우저가 part별 SHA-256을 `crypto.subtle`로 계산해 presigned `UploadPart`(900초, `x-amz-checksum-sha256` 헤더)로 **S3에 직접 PUT**합니다. 완료 시 `CompleteMultipartUpload` 후 `HeadObject(ChecksumMode=ENABLED)`로 실제 VersionId를 확인합니다. 중단된 업로드는 `ListMultipartUploads`/`ListParts`로 이어받거나 `AbortMultipartUpload`합니다.
3. **검증 및 버전 확정**: 업로드를 동결하고 `ListObjectsV2`/`HeadObject`로 확인한 뒤 `DS#<name>/FINALIZE#<v>`(GSI `TYPE#DATASET_FINALIZATION`)를 씁니다.
4. **controller 워커 `finalizePendingVersions`**(10초)가 GSI를 폴링해 `snapshotPrefix`로 스테이징 → 아티팩트 버킷 `projects/<p>/datasets/<name>/versions/v<N>/`에 검증 사본과 `manifest.json`을 만들고, 조건부 트랜잭션으로 `state=READY`, `manifestVersionId`, `manifestHash`, `fsxPath=/fsx/datasets/projects/<p>/<name>/v<N>`를 기록합니다.
5. FSx DRA(`/datasets ↔ s3://…/datasets/`)가 자동 import하므로 레시피 Pod는 로컬 파일로 읽습니다(task 전체 1,024파일·64그룹, URL 64개씩 전달).

### 규칙과 검증 실적

- READY 버전은 불변. 참조된 버전 삭제는 거부, 삭제는 tombstone(옵션 `purge` 시 `DeleteObjects`).
- 다운로드는 `HeadObject(VersionId, ChecksumMode)`로 무결성 확인 후 presigned GET 300초.
- 비관리자 S3 경로는 `projects/<p>/`, `datasets/projects/<p>/`, `checkpoints/projects/<p>/`로 제한(`assertStorageScope`).
- 실제 검증: 5 GiB+1 MiB(81 parts) 재시도 후 전체 SHA-256 복원, 65파일 hydration, 10.45 GB GR00T artifact의 archive → READY → 모델 등록.

---

## 6. 모델·평가

![모델·평가·파이프라인·MLflow 다이어그램](diagrams/04-모델-SageMaker-학습-MLflow.drawio.png)

![모델·평가](screenshots/06-models.png)

### 화면

- 리소스 스트립: 모델 패키지 그룹 `groot-sm-models-913524902871`, 아티팩트 버킷 `groot-sm-artifacts-…`. 데이터 출처 `DynamoDB model/evaluation records · SageMaker DescribeModelPackage · ListModelPackages · S3 GetObject`.
- 탭 **프로젝트 모델 | 기존 AWS 모델 · 관리자**(legacy: S3 `models/groot-sm/`, EKS `checkpoints/`, SageMaker `ListModelPackages`, MLflow registered models).
- 왼쪽 모델 목록(예: `UI audit 2026-09-18 CPU`, `gr00t-n16-so101-e2e`, `Imported workshop GR00T ch…`), 오른쪽 모델 카드(원본 실행/작업, 고정 출력 버전, 체크포인트, 계보 disclosure, 품질 승인 배지).
- **출력에서 모델 등록**: 게시된 READY 출력 → `GET /api/models/outputs/:dataset/:version`으로 checkpoint 파일 선택 → `POST /api/models`(생산 태스크 SUCCEEDED·`artifactReceipts`·manifest 경로·VersionId·해시 검증).
- **검증된 평가 이력**: `evaluation.json` 연결(`POST /api/evaluations`, S3 `HeadObject ChecksumMode`), 보고서/영상은 `GET /api/evaluations/:id/artifact?kind=report|video`(presigned 302), **새 평가 실행**은 새 실행 마법사로 연결.
- **애플리케이션 품질 기준**: 최소 평가 횟수(20)·최소 성공률(80%)·최대 p95 지연(100 ms) → 기준 확인 / 승인(`POST /api/models/:id/promotion`). 표본 부족은 "검토 필요"로 남기며 이 동작은 Model Registry를 변경하지 않습니다.
- 파이프라인 연동 모델이면 **Registry 승인 전파**(`POST /api/models/:id/registry-approval {gateId, confirm}`) → SageMaker `DescribeModelPackage` 재확인 → `UpdateModelPackage(ModelApprovalStatus=Approved)` → 재조회로 확인. 이것이 대시보드가 수행하는 유일한 Model Registry 변경입니다.

현재 기록된 실제 평가 증거는 MuJoCo 폐루프 2 episodes, 성공률 0%, `REVIEW`, `approved=false`입니다. Smoke·시뮬레이터 성공률·물리 로봇 검증은 서로 다른 증거로 취급합니다.

---

## 7. 실험 비교 (MLflow)

![실험 비교](screenshots/07-experiments-mlflow.png)

- `GET /api/mlflow/experiments`는 이름이 `pai/<projectId>/…`인 실험만, run은 태그 `pai.project_id=<projectId>`가 정확히 하나인 것만 반환해 프로젝트를 격리합니다.
- run 표에서 최대 4개를 선택해 학습 곡선(`GET /api/mlflow/runs/:id/metrics?key=`)과 파라미터 diff를 비교하고, run 상세는 metrics/params/tags/artifacts 탭을 제공합니다.
- **MLflow 열기**(관리자): `CreatePresignedMlflowTrackingServerUrl`(URL 300초, 세션 12시간).
- 백엔드: SageMaker `DescribeMlflowTrackingServer`로 URL을 얻고(10분 캐시) `/api/2.0/mlflow/*` REST를 **SigV4 서비스 `sagemaker-mlflow`** + 헤더 `x-mlflow-sm-tracking-server-arn`으로 호출합니다(헤더가 없으면 500).
- 학습 Pod는 AWS 자격증명 없이 `MLFLOW_TRACKING_URI`를 controller `/tracking/*`(태스크 metrics capability 토큰)으로 두고, controller가 실험 `pai/<project>/<workflowName>`으로 매핑해 프록시합니다. artifact PUT/GET은 controller가 S3 `groot-sm-artifacts/mlflow-artifacts/<run>/`에 직접 처리합니다.

---

## 8. SageMaker 학습 (파이프라인)

![SageMaker 학습](screenshots/08-pipelines-sagemaker.png)

### 화면

- 리소스 스트립: 파이프라인 `groot-sm-finetuning-913524902871`, 실행 역할 `GR00TSageMakerRole-…`, 학습 로그 그룹 `/aws/sagemaker/TrainingJobs`, 학습 이미지 `groot-sm-training:latest`. 데이터 출처 `DescribePipeline · ListPipelineExecutions · DescribePipelineExecution · ListPipelineExecutionSteps · DescribeTrainingJob / CloudWatch Logs GetLogEvents`.
- 파이프라인 정의 카드(ARN, 역할, 변경 시각, 상태, 파라미터 `EmbodimentTag`, `HfDatasetId`, `InstanceType=ml.g5.12xlarge`, `MaxSteps=100`, `GlobalBatchSize=32`, `SaveSteps=50` …), 실행 목록 4건, 단계 설명(TransformDataset → GR00TFinetune → SmokeEval → SmokeGate → RegisterModel).
- **실행 시작**(연구자 + 프로젝트 researcher/project-admin): 파라미터 폼은 localStorage 초안과 `requestId` 멱등 키를 가지며, 거절된 초안 복구 UI가 있습니다.
- **실행 상세**(`/pipelines/executions/:arn`): 단계 stepper, 학습 단계 선택 시 `DescribeTrainingJob`과 CloudWatch 로그 tail, `Executing` 상태에서 중지, **아카이브 패널**(학습 단계+보고서 단계 선택 → 재시도/취소 → "모델로 등록").

### 동작

1. `POST /api/pipelines/executions`는 곧바로 SageMaker를 호출하지 않고 DynamoDB `PROJECT#<p>/PIPELINE#<operationId>`(GSI `TYPE#PIPELINE_INTENT`)에 **의도**를 기록합니다. 프로젝트/소유자 식별 파라미터(`DashboardProjectId`, `DashboardOwnerSubject`)가 주입됩니다.
2. controller `reconcilePipelineIntents`(5초)가 `StartPipelineExecution(ClientRequestToken=operationId)`을 호출하고 응답 ARN을 검증한 뒤 `PIPELINE_EXECUTION#<arn>`을 기록합니다(중복 시작 방지).
3. 학습 작업 이름은 `PIPELINE_JOB#<name>`으로 기록되어 로그 접근 권한 검사에 쓰입니다.
4. **아카이브**: `SageMakerSources.inspect`가 실행 정의·학습 작업 `ModelArtifacts.S3ModelArtifacts`·processing 출력(`evaluation|report`)을 찾고, 워커가 `model.tar.gz`를 `GetObject(VersionId, IfMatch)`로 스트리밍하며 tar를 검사해 아티팩트 버킷 `projects/<p>/pipeline-archives/<id>/`에 `manifest.json`과 함께 저장 → 데이터셋 `sm-output-<id>` READY 게시 → 모델 화면에서 등록 가능(§6).

> 참고: 대시보드의 일반 레시피 실행은 SageMaker Training Job을 만들지 않고 HyperPod EKS의 Kubernetes Job으로 돌아갑니다. 이 화면은 GR00T 파이프라인처럼 **SageMaker 관리형** 실행을 위한 것입니다.

---

## 9. 시뮬레이션·개발 세션 (DCV 포함)

![세션 다이어그램](diagrams/05-시뮬레이션-개발-세션.drawio.png)

![세션](screenshots/09-sessions.png)

### 화면

- 리소스 스트립: 워크스테이션 EC2 `i-048cffe4cd6ad4f3e`, EKS 클러스터, 네임스페이스 `hyperpod-ns-team-a`. 데이터 출처 `DynamoDB session records · Kubernetes API · EC2 DescribeInstances · Start/StopInstances`.
- **Isaac Sim 데스크톱**(관리자): 브라우저 연결 준비됨 → **여기서 보기**(대시보드 안 iframe) / **새 창에서 열기** / 연결 닫기.
- **개발 세션** 표: 종류(TensorBoard, Task application, Task terminal, JupyterLab, VS Code, Port-forward), 프로젝트/대기열(`hyperpod-ns-team-a-localqueue`), 준비 상태, 만료, 열기/연장/종료.
- **새 세션**(연구자): 프로젝트, 앱 종류, TensorBoard 로그 디렉터리(`/fsx/{checkpoints|datasets}/projects/<p>/…`), 터미널·포트포워딩은 실행 중인 자신의 워크플로·RUNNING 태스크·replica·포트(`GET /api/sessions/connect`), TTL.
- **기존 워크스테이션 / DCV 관리**(관리자): EC2 상태(g5.4xlarge, 실행 중), 중지/DCV 열기/편집기 열기/자격 증명 표시(60초 후 숨김), HyperPod GPU 노드용 `aws ssm start-session … AWS-StartPortForwardingSession portNumber=8443` 명령 목록.

### 동작

**워크스페이스 세션**
1. `POST /api/sessions`: 네임스페이스·`fsx-pvc`·Kueue LocalQueue·서비스 계정(IAM role 주석이 **없어야** 함) 확인 → NetworkPolicy `pai-sessions`(ingress 차단) 적용 → **일시중단 Kueue `batch/v1 Job`** 생성. init 컨테이너 `prepare.py`(chown)와 `runtime --verify-isolation`, 워크스페이스 이미지(python 3.12, JupyterLab 4.6, code-server, TensorBoard, 127.0.0.1 바인드), FSx subPath `sessions/projects/<p>/<id>`. DynamoDB `SESS#<id>/META`(CAS revision).
2. **열기**(`POST /api/sessions/:id/launch`): Pod 준비·소유 확인 → 60초 1회용 티켓(SHA-256 해시 저장) → `https://<id>.apps.physical-ai.hi-yoo.com/?ticket=…`(호스트 모드; `GATEWAY_MODE=host`, 기본값).
3. **gateway**가 ALB 호스트 규칙으로 요청을 받아 티켓을 `__Host-pai-session` 쿠키로 교환(DynamoDB 트랜잭션)하고, 이후 모든 요청을 소유자·프로젝트 멤버십·태스크 시도·바인딩 해시로 재인가합니다. 트래픽은 EKS API의 `pods/<name>/portforward`(HTTP/WS) 또는 `pods/<name>/exec`(터미널) WebSocket(`v4.channel.k8s.io`)으로 Pod에 전달되고, 스트림은 5초마다 재검증되며 만료 시각에 정확히 끊깁니다. Origin/Host 검사, 식별 헤더 제거, `Set-Cookie Domain` 제거.
4. controller 워커가 5초마다 만료 세션·DCV 세션을 정리하고 워크플로 취소 시 세션을 회수합니다.

**경로 기반 세션 게이트웨이(HTTP 인그레스, `-c ingress=http`)** — 이 문서가 기술하는 배포(`physical-ai.hi-yoo.com`)는 HTTPS/호스트 모드이며, 아래는 코드 기준 설명이고 이 환경에서 실측한 것은 아닙니다. 와일드카드 인증서·DNS가 없으므로 `GATEWAY_MODE=path`, `GATEWAY_PUBLIC_ORIGIN=http://<ALB DNS>:8080`을 web·controller·gateway 컨테이너에 주입하고, ALB에 `:8080` 리스너를 별도로 추가해 게이트웨이로 포워딩합니다(`infra/lib/constructs/ingress.ts`, `gateway-service.ts`). 세션은 `http://<ALB DNS>:8080/s/<sessionId>/…`로 열리고, 게이트웨이 쿠키는 `pai-session-<id>`(`Path=/s/<id>/`, http origin이므로 `Secure` 없음), 업스트림 앱의 `__Host-` 쿠키는 `pai-app-<name>`으로 바꿔 `/s/<id>` 하위로 재-scope됩니다(`Domain` 제거). `Host`/`X-Forwarded-Host`는 ALB DNS:8080, `X-Forwarded-Prefix: /s/<id>`가 추가되고, 세션 Pod는 `PAI_SESSION_PREFIX=/s/<id>`를 받아 JupyterLab은 `--ServerApp.base_url`, TensorBoard는 `--path_prefix`로 그 경로 아래에서 응답합니다(`session-image/session.py`). Isaac Sim DCV는 이 모드에서 **새 창 열기만** 지원합니다(대시보드 iframe 임베드는 호스트 모드 전용 설계이며, 이 배포 환경에는 실제 HTTP 배포가 없어 실측하지 않았습니다). `__Secure-` 접두사 쿠키를 쓰는 업스트림 앱은 평문 HTTP origin에서 그 쿠키를 저장할 수 없어(브라우저 제약) 이 모드에서 동작하지 않습니다. 경로 모드에서는 모든 세션이 같은 origin(`GATEWAY_PUBLIC_ORIGIN`)을 공유하므로 `localStorage`/`sessionStorage`/`IndexedDB`/`BroadcastChannel` 같은 클라이언트 저장소는 세션 간에 격리되지 않습니다(인증 쿠키는 이름·`Path`·`routeBinding` 검사로 계속 격리됩니다). 게이트웨이는 응답에서 `Service-Worker-Allowed` 헤더를 제거해 세션 앱이 자신의 `/s/<id>/` 스코프 밖에 서비스 워커를 등록해 다른 세션의 응답을 관찰하는 경로는 막지만, 그 외 저장소 공유 자체는 도메인 없는 신뢰 네트워크 배포를 위한 구조적 트레이드오프이며 호스트 모드의 세션별 origin 격리보다 약합니다. 자세한 내용은 [gateway README](../web/src/server/gateway/README.md#modes).

**DCV(Isaac Sim) 세션**
1. 관리자 **설정**: SSM `SendCommand(AWS-RunShellScript)`로 EC2에 `dcv-agent.zip`(CDK asset S3)을 내려 `bootstrap.py` 실행 → 로컬 HMAC 검증기(127.0.0.1:18544) 설치, 호스트명·인증서·DCV 세션 ID를 `SYS/DCV_REGISTRATION`에 저장.
2. **여기서 보기**: `kind=dcv` 세션 생성 → launch 시 Secrets Manager의 DCV SSO secret으로 `authToken`(aud `pai-dcv`, 120초) 서명 → gateway가 SSM `StartSession(AWS-StartPortForwardingSession → 8443)` 터널(session-manager-plugin)을 열어 TLS로 DCV 서버에 연결.
3. gateway는 `kind=dcv` 응답에서만 `X-Frame-Options`를 제거하고 CSP `frame-ancestors 'self' <대시보드 origin>`으로 교체해 iframe 임베드를 허용합니다.
4. 관리자 워크스테이션 제어는 EC2 `DescribeInstances`/`StartInstances`/`StopInstances`, 자격 증명은 Secrets Manager `GetSecretValue`.

> 워크스테이션(g5.4xlarge)은 켜져 있는 동안 비용이 발생합니다. 공유 DCV 콘솔은 관리자용이며 워크로드별 노드 전용 DCV는 아닙니다.

- **라이브 뷰**: 대시보드 "실시간 보기" 기능은 두 가지 방식을 지원합니다.
  - MuJoCo 훈련: `live: true` 컴파일 옵션으로 자동 활성화.
  - Isaac Lab 훈련: `--live-view on` 플래그(기본값)로 프레임을 PAI_LIVE_DIR 경로에 게시. 카메라 렌더링(RTX)이 동작하려면 Isaac Sim의 Kit 캐시가 쓰기 가능해야 하므로, 워크로드가 UID 1000으로 실행되는 점을 고려해 이미지에서 `/isaac-sim/kit/{cache,data,logs}`와 쓰기 가능한 `HOME`을 1000:1000 소유로 굽습니다(볼륨 마운트 불가). 이 디렉터리가 root 소유이면 셰이더/파생 데이터 캐시 생성이 실패해 `HydraEngine rtx`가 렌더러를 만들지 못하고 프레임이 게시되지 않습니다.
  관리자 DCV 데스크톱과 달리, 라이브 뷰는 각 워크플로우 실행에 연결되며 실시간 MJPEG 스트림을 제공합니다.

---

## 10. 컴퓨트

![클러스터 다이어그램](diagrams/06-컴퓨트-대기열-K8s-작업-메트릭.drawio.png)

| 컴퓨트 | 노드 수 변경 계획 대화상자 |
|---|---|
| ![](screenshots/10-compute.png) | ![](screenshots/10b-compute-scale-plan.png) |

### 화면

- 리소스 스트립: HyperPod EKS `hyperpod-eks-913524902871`, HyperPod Slurm `hyperpod-913524902871`, EKS 클러스터, FSx, 클러스터 로그 그룹 `/aws/sagemaker/Clusters/hyperpod-eks-913524902871`. 데이터 출처 `SageMaker DescribeCluster · ListClusterNodes · ListClusterEvents / EC2 DescribeInstanceTypes / EKS ListAddons · DescribeAddon / Kubernetes API / FSx Describe*`.
- 탭 **EKS | Slurm**. 클러스터 카드(상태 `InService`, 자동 노드 복구 켜짐, ARN, 생성 시각).
- **인스턴스 그룹**: `cpu-c5-4x`(ml.c5.4xlarge, 16 vCPU·32 GB, 2/2), `gpu-g5-8x`(ml.g5.8xlarge, 32 vCPU·128 GB·GPU 1× A10G, 1/1). vCPU/메모리/GPU는 EC2 `DescribeInstanceTypes`(6시간 캐시) 값이며 알 수 없으면 비웁니다. 관리자에게 **계획·차단 사유** 버튼.
- **Kubernetes 노드**(EKS): 준비 상태, GPU 할당/용량, 건강 라벨, kubelet 버전, taints, 관리자 **재부팅/교체**.
- **Add-ons**: `amazon-sagemaker-hyperpod-observability` v1.2.0, `amazon-sagemaker-hyperpod-taskgovernance` v1.6.0, `aws-fsx-csi-driver` v1.10.0, `eks-pod-identity-agent` v1.3.10.
- **연결**: `aws eks update-kubeconfig …` 명령. Slurm 탭은 `head-node.sh`와 `provisioning_parameters.json`(S3 `GetObject`)의 controller/login 역할.
- **FSx for Lustre**: EKS·Slurm 파일 시스템 2개(1.2 TiB, DNS·마운트 이름, DRA 3개 `/datasets`, `/enroot`, `/checkpoints` ↔ S3 접두사), **지금 내보내기**(연구자, `CreateDataRepositoryTask EXPORT_TO_REPOSITORY`).

### 노드 수 변경(관리자) 동작

1. `GET /api/clusters/:name/scale` **스냅샷**: `DescribeCluster` + K8s 노드/Pod + `ListClusterNodes` + DynamoDB 활동 스캔(워크플로·세션·데이터셋 확정) + `SelfSubjectAccessReview(nodes/patch)` → 현재/목표/보호 기준, 보호 인스턴스 ID, **차단 사유**(`pods_active`, `workflows_active`, `sessions_active`, `dataset_finalization`, `policy_missing`, `cluster_changing`, `cordon_permission_unknown` …). 스크린샷에서는 시스템 Pod(grafana, observability, kueue 등)가 있어 `pods_active`, 정책 미설정으로 `policy_missing`이 표시됩니다.
2. `PUT …/scale/policy`: 최소·기준 노드 수, 유휴 분, 유휴 자동 축소 허용(기본 **비활성**), 낙관적 `expectedVersion`.
3. `POST …/scale/plan`: 목표 노드 수로 계획(5분 TTL). 축소 대상은 보호되지 않은 노드를 오래된 순으로 선택.
4. `POST …/scale`: 임대 획득 → 재스냅샷 → `PREPARING/ACTIVE` 기록 → 대상 cordon(JSON-Patch, uid/resourceVersion `test`) → 최종 재검사 → `BatchDeleteClusterNodes`(축소) 또는 `UpdateCluster`(확대, 대상 그룹만 재구성) → `ACCEPTED`. 실패는 `FAILED/BLOCKED`(uncordon) 또는 `UNKNOWN`(자동 재시도 없음).
5. `POST …/scale/reconcile`: 노드 수·인스턴스 소멸 확인 → `SUCCEEDED/PARTIAL/FAILED`, `ACTIVE` 해제. controller `idleScalingTick`(60초)은 `idleEnabled` 정책에서만 자동 축소합니다.

**노드 복구**: 클러스터 `NodeRecovery=Automatic`일 때 라벨 `sagemaker.amazonaws.com/node-health-status=UnschedulablePendingReboot|UnschedulablePendingReplacement`를 merge-patch합니다(web 역할에 `BatchRebootClusterNodes`/`BatchReplaceClusterNodes` 권한이 없어 라벨 방식 사용). 계획 토큰은 노드 uid·라벨·Pod uid의 SHA-256으로 재검증됩니다.

> 이번 검증에서 실제 노드 수를 바꾸거나 idle 정책을 활성화하지 않았으며 GPU 1개를 유지했습니다.

---

## 10a. 리소스

- 화면: `/resources`. `GET /api/resources`(60초 폴링, 서버 60초 캐시)가 Resource Groups Tagging API `GetResources`(TagFilters `RESOURCE_TAG_KEY=RESOURCE_TAG_VALUE`, 기본 `PhysicalAI=true`)를 페이지네이션해 서비스별로 묶고, EC2 인스턴스는 `DescribeInstances`로 상태·타입·프라이빗 IP·AZ를 보강합니다. 콘솔 링크는 EC2·FSx·EKS·HyperPod·S3·DynamoDB·Cognito에만 제공합니다.
- 쓰기 동작은 없습니다. 태그는 대시보드·GrootFinetune·IsaacLab·HyperPodEks 스택이 각자 붙이며, 태그가 없는 리소스는 보이지 않습니다.

---

## 11. 대기열·할당량

![대기열·할당량](screenshots/11-queues-quotas.png)

- `GET /api/queues`(8초): Kueue CRD `kueue.x-k8s.io/v1beta1`의 **ClusterQueue**(cohort, pending/admitted/reserving, flavor·리소스별 quota와 사용량 바, preemption, fair-share weight, conditions), **LocalQueue**, **WorkloadPriorityClass**(training/inference/background), **ResourceFlavor**(nodeLabels), **Workloads** 표(상태 필터). 비관리자는 프로젝트 네임스페이스의 LocalQueue와 그것이 참조하는 ClusterQueue/flavor만 봅니다.
- `GET /api/quotas`: SageMaker HyperPod task governance — `ListClusterSchedulerConfigs`/`DescribeClusterSchedulerConfig`(정책), `ListComputeQuotas`/`DescribeComputeQuota`(팀 할당량).
- **관리자**: 새 컴퓨트 할당량(이름·팀·fair-share weight·인스턴스 타입/개수(`/api/clusters`에서 가져옴)·borrow limit·preempt → `CreateComputeQuota`, `LendAndBorrow`), 새 클러스터 정책(`CreateClusterSchedulerConfig`), 삭제(`DeleteComputeQuota`, `DeleteClusterSchedulerConfig`).
- AWS Service Quotas API는 사용하지 않습니다. 할당량 수정(`UpdateComputeQuota`)은 IAM 권한 추가 전까지 미지원입니다.

---

## 12. Kubernetes 작업

![Kubernetes 작업](screenshots/12-k8s-jobs.png)

- 네임스페이스 선택(`GET /api/k8s/namespaces`: 관리자는 시스템 네임스페이스를 제외한 전체, 그 외는 자기 프로젝트 네임스페이스), 상태 필터·검색, 통계(실행/대기/성공/실패).
- 작업 표(5초): Kueue 큐/우선순위 라벨, 워크플로/태스크 라벨, 이미지, GPU 요청, Pod 목록. `GET /api/k8s/jobs?ns=`는 `batch/v1 jobs`와 pods를 `job-name` 라벨로 결합합니다.
- **로그** 대화상자: Pod 선택, follow(2초 폴링), 검색, `.log` 다운로드. 소스는 kubelet `pods/<name>/log`이며 대시보드 관리 Pod는 시도별 Secret으로 redaction, 검증 불가 시 비관리자는 403.
- **삭제**(연구자): `DELETE /api/k8s/jobs/:ns/:name`(propagationPolicy Background). 클러스터 이벤트 카드(5초).
- AWS 호출은 EKS `DescribeCluster`와 STS presign만이며 나머지는 Kubernetes REST입니다.

---

## 13. 메트릭

![메트릭](screenshots/13-metrics.png)

- 리소스 스트립: AMP 워크스페이스 `ws-25f09b6a-7cb7-45e0-a5d1-89426f633555`, 클러스터 로그 그룹. 데이터 출처 `Amazon Managed Service for Prometheus query_range · query (PromQL over SigV4)`.
- 탭 **대시보드 | Grafana(관리자)**. 시간 범위 15m…7d, 자동 새로 고침 30초, 관리자용 노드 필터.
- 카드: **GPU**(DCGM util/mem, 관리자는 power/temp/SM clock 추가), **노드**(관리자: node_exporter CPU/mem/net; 연구자: 프로젝트 네임스페이스 Pod의 cAdvisor CPU/mem), **Kueue**(pending/admitted, ClusterQueue별 GPU/CPU 사용), **가용 자원**(GPU allocatable vs requested, 관리자). 각 섹션은 사용한 PromQL을 표시합니다.
- `POST /api/metrics/query`: `{queries[{id, metric, params}], range}`로 ≤12개 배치, ≤7일/11k 샘플. 브라우저는 원시 PromQL을 보내지 않고 서버의 허용 목록 빌더(`METRICS`)만 사용합니다. 비관리자는 `scopedMetric`이 `namespace=<프로젝트 ns>`를 강제하고 노드 메트릭을 Pod 메트릭으로 재작성, Kueue 메트릭은 프로젝트 ClusterQueue로 한정합니다.
- 백엔드: `https://aps-workspaces.us-east-1.amazonaws.com/workspaces/<id>/api/v1/{query,query_range,label/*/values}`를 **SigV4 서비스 `aps`**로 호출(AMP SDK 클라이언트 아님). Grafana 탭은 EKS API 서버 `services/proxy`로 클러스터 내 Grafana(`grafana` 네임스페이스 secret basic-auth)를 same-origin 프록시합니다.
- 스크린샷 시점에는 GPU 작업이 없어 "GPU 메트릭 없음"이 표시됩니다.

---

## 14. 파일 (S3·FSx)

![파일·사용량·비용 다이어그램](diagrams/07-파일-사용량-비용.drawio.png)

![파일](screenshots/14-storage-files.png)

- 버킷 탭은 `GET /api/s3`의 허용 목록(대시보드 아티팩트, `hyperpod-eks-data`, `groot-sm-artifacts`, Slurm 데이터). 비관리자는 `projects/<p>/` 또는 `datasets/projects/<p>/` 루트로 고정됩니다.
- **S3 브라우저**: 브레드크럼, 폴더/객체(크기·시각), 선택, **다운로드**(presigned GET 900초), **업로드**(presigned PUT 3600초, XHR 진행률, 연구자, `projects/<p>/scratch/` 한정), **삭제**(관리자, `DeleteObjects` ≤1000 또는 접두사 전체). 각 접두사의 FSx 미러 경로 `/fsx/<prefix>` 표시. 목록은 `ListObjectsV2(Delimiter='/', MaxKeys=200)`.
- **FSx 섹션**(10초): 수명 주기·용량·DNS·마운트 이름·DRA 표, **데이터 리포지토리 작업 생성**(연구자, `EXPORT_TO_REPOSITORY` / `IMPORT_METADATA_FROM_REPOSITORY`, `/fsx/` 접두사 제거), 작업 표(5초, `DescribeDataRepositoryTasks` 최근 20). `FSX_FILE_SYSTEM_ID`/`SLURM_FSX_FILE_SYSTEM_ID`만 허용됩니다.

---

## 15. 사용량

![사용량](screenshots/15-usage-cost.png)

- 프로젝트 선택, **사용량 새로 고침**. 통계 CPU-hour / GPU-hour, 실행별 표(완료/불완전 배지, 실행 상세 링크).
- `GET /api/usage?projectId`: 워크플로 ≤1000건에 대해 DynamoDB 태스크 원장과 `WF#<id>/RUNTIME#<epoch>#MEMBER` 영수증(없으면 태스크 관찰)으로 태스크별 replica 실행 시간을 구하고, **그 시간 × 태스크 스펙의 요청 CPU 수**와 **그 시간 × 요청 GPU 수**를 각각 독립적으로 합산합니다(노드 vCPU/GPU 용량으로 정규화하지 않음). 태스크 원장이 없거나(`missing_ledger`) 타이밍이 불완전하거나(`incomplete_timing`) 요청 CPU/GPU 값을 알 수 없으면(`unknown_resources`) 해당 통계는 `null`로 남기고 추정하지 않습니다.
- 금액은 **추정하지 않으며** 실제 CPU/GPU 활용률이 아니고 idle 인프라·스토리지·네트워크는 제외합니다. 홈·관리 패널의 "AWS 계정 전체 비용"은 Cost Explorer 값으로 대시보드 외 서비스(EC2, Bedrock 등)를 포함합니다.

---

## 16. 프로젝트·구성원

![설정 다이어그램](diagrams/08-설정-프로젝트-이미지-빌드-웹훅-엣지-백엔드.drawio.png)

![프로젝트·구성원](screenshots/16-projects-members.png)

- 프로젝트 목록(현재 `Physical AI Workshop`, 구성원 1명), 선택 시 구성원 편집기(Cognito 사용자별 역할 none/viewer/researcher/project-admin → `PATCH /api/projects/:id`, project-admin 필요).
- 관리자: 사용자 목록(`/api/admin/users`), 백엔드 레지스트리(`/api/backends`), 대기열(`/api/queues?backendId=`), **새 프로젝트**(id·이름·네임스페이스 `hyperpod-ns-*`·backendId). 생성 버튼은 준비된 백엔드와 `<ns>-localqueue` LocalQueue가 존재할 때만 활성화되며 서버가 Kueue에서 다시 확인합니다.
- 저장: DynamoDB `PROJECT#<id>/META`(GSI `TYPE#PROJECT`), 네임스페이스 소유권 `PROJECT_NAMESPACE#<backend>#<ns>/OWNER`를 한 트랜잭션으로. 관리자 첫 접근 시 기본 프로젝트 `workshop`(`hyperpod-ns-team-a`)이 자동 생성됩니다. 프로젝트 선택은 헤더 `x-pai-project` 또는 쿠키 `pai-project`이며 토큰 세션은 토큰의 프로젝트로 고정됩니다.

---

## 17. 자격증명·API 토큰

![자격증명·API 토큰](screenshots/17-access-credentials-tokens.png)

- 리소스 스트립: Cognito 사용자 풀 `us-east-1_YpnKXG6LG`. 데이터 출처 `DynamoDB API-token records · SSM Parameter Store …`.
- **자격증명**: 이름·종류(hf/ngc/generic)·범위(private/project)·값 → `POST /api/credentials`. SSM `PutParameter(SecureString)`로 `/physical-ai/projects/<p>/{users/<sha256(sub)>|shared}/<id>`에 저장하고 DynamoDB에는 `ref`·상태(CREATING→READY, ROTATING, DELETING, ERROR)와 고유성 키만 둡니다. 워크플로에는 값 대신 `ref`를 전달하고 controller가 실행 시 `GetParameter`로 해석합니다. 회전(`/rotate`, Overwrite), 삭제(`DeleteParameter`), 관리자 **legacy 등록**(기존 `/groot|/pai|/physical-ai/*` 경로 참조). 프로젝트 공유 자격증명은 project-admin이 필요합니다.
- **API 토큰**: 이름·scope(workflows/datasets/sessions/models/metrics의 :read/:write; viewer는 :read만)·만료(1–30일) → `POST /api/tokens`. 토큰 `pai_<43자>`는 발급 시 한 번만 표시되고 SHA-256 해시만 저장됩니다(`API_TOKEN#<hash>` + TTL). 폐기 `DELETE /api/tokens/:id`. 토큰으로 인증한 호출은 토큰·자격증명·웹훅·프로필·엣지·빌드·관리 라우트를 관리할 수 없습니다.
- CLI 힌트 카드: `pai login`은 `/api/v1/me`가 `authMethod: token`을 돌려줄 때만 `~/.config/physical-ai/credentials.json`(0600)에 저장합니다.

---

## 18. 이미지·실행 환경

![이미지·실행 환경](screenshots/18-image-profiles.png)

### 이미지 프로필

- 프로젝트 이미지 목록: `groot/isaaclab/mujoco/openpi/ros2 deployment image`(승인 v6), `runtime`(v3), `workspace`(v2), 소스 빌드 증거 `0fe0610311cf`(사용 중지). 각 항목은 `<acct>.dkr.ecr.us-east-1.amazonaws.com/cdk-hnb659fds-container-assets-…@sha256:…`, 아키텍처 amd64, 검사 시각을 표시합니다.
- 관리자: **배포 이미지 후보 검사**(`POST /api/image-profiles/seed`: 내장 이미지 환경 변수 URI를 ECR에서 검사해 *미승인* 후보 생성, 기존 승인 버전은 덮어쓰지 않음), **만들기 → 검사하고 승인 버전 저장**(식별자·이름·private ECR tag/digest·허용 플랫폼·연결 소스 빌드 ID·최소 vCPU/RAM/GPU/VRAM → `POST /api/image-profiles`, 리비전 `IMAGE_PROFILE_REV#<id>#<v>` 기록), 사용 중지(`DELETE`).
- **워크플로우 사전 검사**: YAML/JSON 붙여넣기 → `POST /api/image-profiles/preflight`(읽기 전용). 태스크 이미지마다 정확히 1개의 활성 승인 프로필이 필요하고(`image_profile_unapproved|ambiguous`), ECR을 다시 검사해 digest 변경(`image_digest_changed`)을 차단하고 하드웨어(노드 사양) 요구를 검사합니다.
- ECR 검사: `DescribeImages`(tag → digest), `GetAuthorizationToken` 후 Registry v2 manifest/config를 digest로 가져와 SHA-256 검증(OCI index 지원, 같은 계정 private ECR만; 외부 레지스트리는 미러링 필요).
- 실행 시점: `IMAGE_PROFILES_ENFORCED=1`이면 controller가 launch 직전에 head·리비전을 다시 읽고 `check` 기록을 남겨, 큐 대기 중 승인이 철회되면 `image_approval_changed`로 차단합니다. **레시피를 바꿔 워크로드 이미지가 재빌드되면 승인이 모두 무효화**되므로 배포 후 재승인이 필요합니다.

### 관리자 승인 특수 실행(실행 프로필)

- host network/privileged/root/마운트가 필요한 작업을 전용 노드와 불변 승인 버전에 연결하는 별도 신뢰 경계(`EXECUTION_PROFILES.md`). 승인 조건: 이미지가 이미 승인됨, `@sha256` 고정, 노드가 Ready·schedulable이며 라벨 `pai.aws.node-restriction.kubernetes.io/execution-profile=trusted-<hash>`와 taint `pai.aws/execution-profile`(NoSchedule), `node-health-status=Schedulable`, 신뢰/시스템 Pod만 상주. 승인 태스크 해시가 바뀌면 재승인 필요. 현재 승인된 특수 실행은 없습니다.

---

## 19. 디바이스·배포 (엣지)

![디바이스·배포](screenshots/19-edge-devices.png)

- 리소스 스트립: IoT 사물 그룹 `groot-913524902871-group`, Greengrass 구성 요소 `com.workshop.913524902871.inference`. 홈 아키텍처 카드에서는 `ThingGroup … not found`가 표시되어 현재 계정에 실제 사물 그룹이 없음을 알 수 있습니다.
- **프로젝트 디바이스 등록**(project-admin): 종류(thing/core/thing-group/virtual)·라벨·대상 이름·아키텍처·물리 장치 확인 → `POST /api/edge/devices`(`DEVICE_TARGET#<sha256>` 고유성).
- **배포**(연구자): 이름·프로필·모델 → `POST /api/edge/deployments`(준비만) → 작업 뷰에서 **제출/재시도**(`POST /api/edge/operations/:id/submit`), **롤백**(이전 desired 구성을 새 작업으로), 상태 `PREPARED→SUBMITTING→SUBMITTED→RUNNING→SUCCEEDED|FAILED`(+`SUBMISSION_UNKNOWN`). 추론 배포는 모델의 품질 승인(§6)이 필수이며 미승인 벤치마크는 명시 플래그가 필요합니다.
- **Lease**: HIL 독점 임대(epoch + 토큰 해시, TTL 30–3600초) claim/validate/renew/release. **벤치마크** 수집(작업 산출물 또는 가져온 payload).
- AWS: IoT `DescribeThingGroup`/`ListThingsInThingGroup`/`DescribeThing`; Greengrass v2 `GetCoreDevice`, `ListInstalledComponents`, `GetComponent`, `ListDeployments`, `GetDeployment`, `ListEffectiveDeployments`, `CreateDeployment`(개별 `:thing/` core ARN만, `clientToken`, `failureHandlingPolicy=ROLLBACK`, 태그 `pai:project/operation/device`); S3 아티팩트 버킷 `projects/<p>/edge/<device>/operations/<op>/{benchmark,readiness}.json`(VersionId·체크섬 고정). 물리 장치 검증과 MCP는 별개입니다.

---

## 20. 자동화·웹훅

![자동화·웹훅](screenshots/20-webhooks.png)

- 프로젝트별 구독 목록(예: `AWS-receiver-510fa4d82177`, DISABLED)과 전달 이력(10초). project-admin/관리자: 활성/비활성(`PATCH`), **DEAD/CANCELLED 재전송**(`POST …/deliveries/:id/redrive`), 새 구독(이름·endpointUrl·secret·상태 필터 → `POST /api/webhooks`), 회전(`POST …/rotate`). secret은 화면에 다시 표시되지 않습니다.
- 저장: endpoint+secret은 SSM `PutParameter(SecureString)` `/physical-ai/projects/<p>/webhooks/<hookId>`(버전 지정 `GetParameter`), DynamoDB `PROJECT#<p>/WEBHOOK#<id>`, `WEBHOOK_EVENT#<eventId>`, `DELIVERY#`(GSI `TYPE#WEBHOOK_DELIVERY_PENDING`). 프로젝트당 활성 훅 ≤32.
- 전달: 워크플로 종료 커밋 후 `enqueueWorkflowWebhook`가 본문(≤16 KiB)과 구독자 집합을 동결 → controller `deliverWebhooks`(5초)가 임대 30초로 `PENDING→SENDING→DELIVERED|RETRY|DEAD|CANCELLED`, 8회/24시간, 백오프 `min(1h, 10s·2^(n-1))`. 헤더 `x-pai-event-id`, `x-pai-timestamp`, `x-pai-delivery-id`, `x-pai-signature: v1=HMAC-SHA256(secret, "<ts>.<eventId>.<rawBody>")`. HTTPS 443만, 매 시도 DNS 재해석, 사설/예약 IP 거부, SNI 유지, 리다이렉트 없음, 10초 총/5초 idle.
- 웹훅 전달은 DynamoDB outbox와 controller 웹훅 루프(5초)가 처리하며 SQS/EventBridge를 쓰지 않습니다. 관리자 `notifyOn` 알림은 별도로 SNS `Publish`입니다.

---

## 21. 환경 빌드

![환경 빌드](screenshots/21-builds.png)

- 사이드바 노출은 관리자 전용이지만 라우트는 프로젝트 구성원도 사용할 수 있습니다.
- **빌드 출처**: `SOURCE_BUILD_TARGETS_JSON`의 대상(`workshop · S3`)을 등록(`POST /api/builds/sources`, project-admin) → 등록 시 ECR `DescribeRepositories`, S3 스냅샷 `HeadObject/GetObject`(VersionId + SHA-256)를 확인. **이미지 빌드 시작**(연구자, Git이면 commit SHA): `StartBuild(sourceVersion, idempotencyToken=sha256(actor:project:requestId), environmentVariablesOverride PAI_*)`와 고정 buildspec(zip/commit SHA 검증 → `docker build --platform linux/amd64` → 태그 `pai-source-<buildId>` → ECR push). 프로젝트당 동시 2슬롯.
- **빌드 이력/상세**: `STARTING|START_UNCERTAIN|RUNNING|CANCELLING|VERIFYING|SUCCEEDED|FAILED|CANCELLED`, 로그 tail(CloudWatch Logs `GetLogEvents`), 취소(`StopBuild`), CodeBuild ID로 복구(`ListBuildsForProject`+`BatchGetBuilds`, `PAI_REQUEST_ID` 일치), 관리자용 "이 digest를 이미지 프로필로 승인" 링크.
- controller `reconcileSourceBuilds`가 `BatchGetBuilds`로 상태를 추적하고 빌드 식별(`PAI_REQUEST_ID`, `PAI_REGISTRATION_HASH`), 내보낸 `PAI_SOURCE_TREE_SHA256/PAI_DOCKERFILE_SHA256`, ECR `DescribeImages` → digest → 이미지 검사(amd64)를 거쳐 `provenance.output.resolvedImage=<repo>@sha256:…`를 기록합니다. 출력 리포지토리는 `physical-ai/projects/<p>/source-images`(IMMUTABLE).
- **플랫폼 관리자 작업**: 운영 CodeBuild(`<prefix>-operations`, VPC 내)로 `infra/ops/apply_addons.py`를 실행해 EKS RBAC(ClusterRole `physical-ai-discovery/scaling`, 네임스페이스별 Role·SA `pai-workload`·NetworkPolicy), VPC CNI network policy, JobSet v0.12.0 설치를 동기화합니다(`BatchGetProjects`, `ListBuildsForProject`, `StartBuild`).
- 실제 검증: S3 source → CodeBuild → ECR digest → 프로필 연결 PASS(작은 `FROM scratch` 이미지).

---

## 22. 백엔드 연결

![백엔드 연결](screenshots/22-backends.png)

- 관리자 전용. 기본 EKS(`hyperpod-eks-913524902871`, 기존 기본 연결·설정됨)와 `EKS_BACKENDS_JSON` 환경 변수에 선언된 추가 백엔드. 등록/새 버전 등록/활성·비활성(`POST /api/backends`), **연결 확인**(`POST /api/backends/:id/check`), 결과 findings와 리비전 이력, "프로젝트 만들기" 링크.
- 프로브: EKS `DescribeCluster`(ACTIVE, private endpoint, `BACKEND_HOME_VPC_ID` 일치) → Kubernetes `/version`, JobSet API, `SelfSubjectAccessReview`(nodes·namespaces·PV·priorityclasses·kueue·jobsets), 네임스페이스별 LocalQueue와 `fsx-pvc` PV(`fsx.csi.aws.com`, volumeHandle=fsxFileSystemId). 체크 유효 15분, `configurationHash` 변경 시 `configuration_changed`, 미준비면 409 `backend_unavailable`.
- HTTP 요청으로 endpoint/role을 설정할 수 없고 **STS AssumeRole·cross-account는 지원하지 않습니다**. 모든 API 호출은 `withRequestBackend`로 프로젝트의 백엔드에 바인딩됩니다. 추가 백엔드의 실제 검증은 아직 없습니다.

---

## 23. 플랫폼 설정 (관리자)

| 사용자 | 감사 로그 |
|---|---|
| ![](screenshots/23-admin-platform-settings.png) | ![](screenshots/23b-admin-audit.png) |

| 설정 | 비용 |
|---|---|
| ![](screenshots/23c-admin-settings.png) | ![](screenshots/23d-admin-cost.png) |

- 리소스 스트립: DynamoDB 테이블, Cognito 사용자 풀. 데이터 출처 `Cognito ListUsers · ListGroups · AdminCreateUser · AdminSetUserPassword · AdminAddUserToGroup / DynamoDB settings and audit log / Cost Explorer GetCostAndUsage`.
- **사용자**: 목록(`ListUsers` + 사용자별 `AdminListGroupsForUser`), 만들기(`AdminCreateUser(MessageAction=SUPPRESS)` + `AdminSetUserPassword(Permanent)` + `AdminAddUserToGroup`), 역할 변경(`AdminAdd/RemoveUserFromGroup`), 비밀번호 재설정.
- **감사 로그**: `AUDIT` 파티션 최근 200건(모든 non-GET API 자동 기록).
- **설정**: `notifyOn`(SUCCEEDED/FAILED/CANCELLED → SNS), 기본 네임스페이스, 기본 우선순위; 현재 `config()`와 환경 변수 스냅샷(`*SECRET*` 마스킹), controller 상태와 `SYS/LEASE#CONTROLLER`.
- **비용**: Cost Explorer 최근 30일 서비스별(홈 카드와 동일 API).

---

## 24. AWS 서비스별 사용 API 총괄표

| AWS 서비스 | 대시보드에서 호출하는 API | 사용 화면 |
|---|---|---|
| Amazon Cognito | Hosted UI(ALB), `ListUsers`, `ListGroups`, `AdminCreateUser`, `AdminSetUserPassword`, `AdminAddUserToGroup`, `AdminRemoveUserFromGroup`, `AdminGetUser`, `AdminListGroupsForUser` | 로그인, 플랫폼 설정, API 토큰 |
| Elastic Load Balancing | authenticate-cognito, 호스트/경로 규칙, ELB 공개키 조회 | 전 화면, 세션 호스트 |
| Amazon DynamoDB | Get/Put/Update/Delete/Query/Scan/TransactWrite(단일 테이블) | 전 화면 |
| Amazon S3 | `ListObjectsV2`, `HeadObject`/`HeadBucket`, `GetObject`(VersionId), `PutObject`(IfNoneMatch), `CopyObject`, `Create/Upload/Complete/Abort MultipartUpload`, `UploadPartCopy`, `ListParts`, `ListMultipartUploads`, `DeleteObjects`, presign GET/PUT | 데이터셋, 파일, 실행 산출물, 모델, 파이프라인 아카이브, 엣지 |
| Amazon FSx for Lustre | `DescribeFileSystems`, `DescribeDataRepositoryAssociations`, `DescribeDataRepositoryTasks`, `CreateDataRepositoryTask` | 컴퓨트, 파일, 실행 게시 |
| Amazon EKS / Kubernetes | `DescribeCluster`, `ListAddons`, `DescribeAddon`; K8s REST(nodes·pods·jobs·events·namespaces·configmaps·secrets·PV/PVC, JobSet, Kueue CRD, `pods/exec|portforward|log`, `services/proxy`, `SelfSubjectAccessReview`) | 실행, 세션, 컴퓨트, 대기열, 작업, 메트릭(Grafana), 백엔드, 프로젝트 |
| AWS STS | presigned `GetCallerIdentity`(K8s bearer 토큰) | K8s 호출 전체 |
| Amazon SageMaker (HyperPod) | `ListClusters`, `DescribeCluster`, `ListClusterNodes`, `DescribeClusterNode`, `ListClusterEvents`, `UpdateCluster`, `BatchDeleteClusterNodes`, `List/Describe/Create/Delete ComputeQuota`, `List/Describe/Create/Delete ClusterSchedulerConfig` | 홈, 컴퓨트, 대기열·할당량 |
| Amazon SageMaker (AI) | `DescribePipeline`, `ListPipelineExecutions`, `StartPipelineExecution`, `StopPipelineExecution`, `DescribePipelineExecution`, `ListPipelineExecutionSteps`, `ListPipelineParametersForExecution`, `DescribePipelineDefinitionForExecution`, `DescribeTrainingJob`, `ListTrainingJobs`, `DescribeProcessingJob`, `DescribeModelPackage`, `ListModelPackages`, `UpdateModelPackage`, `DescribeMlflowTrackingServer`, `CreatePresignedMlflowTrackingServerUrl`, MLflow REST(SigV4 `sagemaker-mlflow`) | SageMaker 학습, 모델·평가, 실험 비교 |
| Amazon Managed Service for Prometheus | `/api/v1/query`, `query_range`, `label/*/values`(SigV4 `aps`) | 홈, 메트릭, 실행 메트릭 탭 |
| Amazon EC2 | `DescribeInstanceTypes`, `DescribeInstances`, `StartInstances`, `StopInstances` | 컴퓨트, 세션(DCV), 이미지 프로필 |
| AWS Resource Groups Tagging API | `GetResources` | 리소스 |
| AWS Systems Manager | `PutParameter`, `GetParameter`, `DeleteParameter`(SecureString); `SendCommand`, `GetCommandInvocation`, `StartSession`, `TerminateSession` | 자격증명, 웹훅, 세션(DCV) |
| AWS Secrets Manager | `GetSecretValue`(DCV 자격증명·SSO secret), 컨테이너 secret 주입(`RUNTIME_SIGNING_KEY`) | 세션(DCV), controller |
| Amazon ECR | `DescribeImages`, `GetAuthorizationToken`, `DescribeRepositories`, Registry v2 manifest/blob | 이미지 프로필, 환경 빌드, 실행 사전 검사 |
| AWS CodeBuild | `BatchGetProjects`, `ListBuildsForProject`, `BatchGetBuilds`, `StartBuild`, `StopBuild` | 환경 빌드 |
| Amazon CloudWatch Logs | `DescribeLogGroups`, `DescribeLogStreams`, `FilterLogEvents`, `GetLogEvents` | 파이프라인 실행 상세, 환경 빌드 |
| Amazon SNS | `Publish` | 실행 종료 알림 |
| AWS Cost Explorer | `GetCostAndUsage` | 홈, 플랫폼 설정 |
| AWS IoT Core / Greengrass v2 | `DescribeThingGroup`, `ListThingsInThingGroup`, `DescribeThing`; `GetCoreDevice`, `ListInstalledComponents`, `GetComponent`, `ListDeployments`, `GetDeployment`, `ListEffectiveDeployments`, `CreateDeployment` | 디바이스·배포, 홈 아키텍처 카드 |
| AWS Cloud Map | 서비스 디스커버리(`controller.<prefix>.internal`) | Pod → controller runtime/tracking API |

---

## 25. 환경 변수 계약과 IaC

- 컨테이너 환경 변수 계약(`infra/lib/env-contract.ts`): `AWS_REGION`, `ACCOUNT_ID`, `AUTH_MODE=alb|cognito`, `COGNITO_APP_CLIENT_ID`, `TABLE_NAME`, `SNS_TOPIC_ARN`, `COGNITO_USER_POOL_ID/CLIENT_ID/DOMAIN`, `DASHBOARD_ORIGIN`, `GATEWAY_BASE_DOMAIN`, `ALB_ARN`, `EKS_CLUSTER_NAME`, `HYPERPOD_EKS_CLUSTER_NAME`, `EKS_DATA_BUCKET`, `FSX_FILE_SYSTEM_ID/DNS_NAME/MOUNT_NAME`, `AMP_WORKSPACE_ID`, `HYPERPOD_SLURM_CLUSTER_NAME`, `SLURM_DATA_BUCKET`, `SLURM_FSX_FILE_SYSTEM_ID`, `ARTIFACTS_BUCKET`, `MLFLOW_TRACKING_SERVER_ARN/NAME`, `SM_PIPELINE_NAME`, `SM_MODEL_PACKAGE_GROUP`, `SM_TRAINING_IMAGE_URI`, `SM_ROLE_ARN`, `DCV_INSTANCE_ID/SECRET_ARN/URL`, `CODE_SERVER_URL`, `DCV_SSO_SECRET_ARN`, `DCV_AGENT_ASSET_URI`, `GREENGRASS_THING_GROUP/INFERENCE_COMPONENT`, `DASHBOARD_ARTIFACT_BUCKET`, `*_IMAGE_URI`(mujoco/isaaclab/ros2/workspace/groot/openpi/cosmos/cosmos3/leisaac), `TASK_RUNTIME_IMAGE`, `IMAGE_PROFILES_ENFORCED=1`, `SESSION_SIGNING_KEY`(secret), `SOURCE_BUILD_TARGETS_JSON`, `BUILD_PROJECTS`, `EKS_BACKENDS_JSON`, `BACKEND_HOME_VPC_ID`, `RUNTIME_API_URL`, `RUNTIME_SIGNING_KEY`(secret), `RESOURCE_TAG_KEY`, `RESOURCE_TAG_VALUE`. 값이 비어 있으면 제거되어 해당 기능(`features.*`)이 꺼집니다.
- **`GATEWAY_MODE`/`GATEWAY_PUBLIC_ORIGIN`/`PAI_SESSION_PREFIX`**(경로 기반 게이트웨이, `env-contract.ts` 밖에서 별도로 주입): `ingress=https`(도메인 3종 지정)에서는 `GATEWAY_MODE`를 생략(기본 `host`)하고 `GATEWAY_BASE_DOMAIN=apps.<domain>`만 설정합니다(`infra/lib/dashboard-stack.ts`, `infra/lib/constructs/gateway-service.ts`). `ingress=http`(도메인 생략)에서는 대신 `GATEWAY_MODE=path`, `GATEWAY_PUBLIC_ORIGIN=http://<ALB DNS>:8080`을 web·controller·gateway 컨테이너에 주입하고 `GATEWAY_BASE_DOMAIN`은 설정하지 않습니다(`infra/lib/constructs/service.ts`의 `pathGatewayEnv`). 두 값은 `web/src/server/gateway/routing.ts`의 `gatewayMode()`/`publicOrigin()`이 읽습니다. 세션 Pod에는 별도로 `PAI_SESSION_PREFIX`(경로 모드에서 `/s/<sessionId>`, 호스트 모드에서 빈 문자열)가 주입되어 JupyterLab/TensorBoard가 그 경로 아래에서 응답합니다(`web/src/server/services/sessions.ts`, `session-image/session.py`).
- 모듈 context(`gateway`, `images`, `imageOverrides`, `sourceBuild`, `edge`, `waf`, `alarms`, `resourceTagKey/Value`, 도메인 3종)는 `infra/lib/modules.ts`가 검증하며 기본값은 기존 배포와 동일합니다(`test/template-parity.test.ts`가 보증). 표는 [README 모듈 선택](../README.md#모듈-선택) 참고.
- **CDK**(`dashboard/infra`)가 실제 배포입니다. 배포 명령은 항상 `-c extendedImages=true`를 포함해야 GR00T/OpenPI 이미지가 유지됩니다. 워크로드 이미지가 재빌드되면 이미지 프로필 재승인이 필요합니다.
- **Terraform**(`dashboard/terraform`)은 동일 리소스를 만드는 포트로 검증 후 destroy된 상태(tfstate 0 리소스)이며, 단순화 설계에서 삭제가 결정되었습니다.
- EKS 측 준비(RBAC, JobSet, network policy)는 운영 CodeBuild가 `infra/ops/apply_addons.py`로 수행합니다. Pod Identity 역할 `<prefix>-workflow-pods`는 SA `pai-workflow`(네임스페이스 `rl`, `hyperpod-ns-team-a`, `hyperpod-ns-team-b`)에 연결됩니다.

---

## 26. 알려진 제한과 설계-배포 차이

- **보안 하드닝 현황**: WAF(AWS 관리 규칙 + 2000 req/IP), ALB access log, CloudWatch 알람 5개, 아티팩트 버킷 Intelligent-Tiering·noncurrent 만료가 적용되어 있습니다. web 태스크 역할에는 `*` 리소스 권한이 일부 남아 있고 서비스 SG 3001 포트가 VPC CIDR 전체에 열려 있습니다(runtime API는 HMAC capability 토큰으로 보호).
- **IAM 공백**: `BatchRebootClusterNodes`, `BatchReplaceClusterNodes`, `UpdateComputeQuota`, `StopTrainingJob` 권한이 없어 노드 복구는 라벨 방식, 할당량 수정·학습 작업 중지는 미지원.
- **역할 모델**: 설계의 4역할(viewer/researcher/project-admin/platform-admin) 대신 Cognito 그룹 3개 + 앱 측 프로젝트 역할.
- **레거시 Pod Identity**: `pai-workflow` SA는 AWS 자격증명을 가지며(3개 네임스페이스), 새 워크로드 모델은 자격증명 없는 `pai-workload`입니다.
- **데이터·실행 한도**: checkpoint 1 TiB/파일(검증 5 GiB+1 MiB), 입력 1,024파일·64그룹·metadata 2 MiB, 로그는 Pod 생존 중에만 조회(요청당 5,000줄, 1 MiB). CLI sync는 파일 단위. 일반 private registry, EFS, Slurm DAG, cross-account 백엔드, MCP 미지원.
- **미검증 항목**: Cosmos/LeIsaac 이미지 빌드·GPU closed-loop, 추가 EKS 백엔드, privileged 실행 프로필 노드, 물리 엣지 장치, 실제 노드 수 변경.
- **다국어**: UI 문구는 ko/en 카탈로그(`pai-locale` 쿠키)이지만 서버 API 오류 문구와 내장 레시피 설명은 단일 언어입니다.
- **스크린샷 캡처 중 관찰**: 샌드박스 브라우저의 네트워크 전환 이벤트 후 TanStack Query의 onlineManager가 offline 상태에 머물러 API는 200을 돌려주는데도 화면이 "불러오는 중"에 고정되었습니다. `window.dispatchEvent(new Event('online'))`로 복구됐습니다. 사용자 환경에서 재현되면 `networkMode`나 온라인 상태 표시를 검토할 가치가 있습니다.

---

## 부록 A. 파일 위치

| 항목 | 경로 |
|---|---|
| 이 문서 | `dashboard/docs/dashboard-features-and-aws-architecture.md` |
| 스크린샷 38장 | `dashboard/docs/screenshots/` |
| 다이어그램 원본(9페이지) | `dashboard/docs/diagrams/physical-ai-dashboard-features.drawio` |
| 다이어그램 PNG(XML 내장) | `dashboard/docs/diagrams/0N-*.drawio.png` |
| 다이어그램 생성 스크립트 | `dashboard/docs/diagrams/gen_diagrams.py`, `export.sh` |
| 다이어그램 가이드 | `dashboard/docs/diagrams/README.md` |
| 배포 전 아키텍처 그림 | `docs/physical-ai-dashboard-architecture.drawio.png` |
| 설계·검증 문서 | `docs/designs/2026-09-16-physical-ai-dashboard.md`, `docs/designs/2026-09-18-dashboard-architecture-simplification.md`, `docs/reports/2026-09-16-feature-evidence.md`, `docs/reports/2026-09-18-ui-infra-review.md` |
