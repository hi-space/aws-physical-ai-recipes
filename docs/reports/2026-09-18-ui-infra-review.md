# UI 동작 및 배포 인프라 검증 — 2026-09-18

**판정: 전체 기능이 정상 동작한다고 볼 수 없다.** 실제 배포에서 관리자 화면, 파일 저장소, 신규 데이터셋 업로드에 결함을 재현했다. HyperPod 노드 축소와 SageMaker 요청 복구에도 실제 인프라·IAM 계약과 코드가 맞지 않는 부분이 있다.

검증 대상은 `physical-ai.hi-yoo.com`, 계정 `913524902871`, 리전 `us-east-1`이다. 로컬 소스 기준 커밋은 `f34700c486787252e9c5e95ddafef94446a4bb10`이다. 기존 작업 파일을 보존하고 제품 코드·배포·노드 수를 변경하지 않았다. 테스트가 만든 실행과 데이터셋은 아래에 구분한다.

근거의 수준을 구분한다.

- **verified / 실제 실행**: 이번 세션의 브라우저 동작, AWS 조회, 로그 또는 IAM 시뮬레이터 결과.
- **verified / 소스 검증**: 코드와 실제 입력 또는 메모리 내 재현으로 확인. 운영 변경을 실행했다는 의미는 아니다.
- **documented**: 공식 문서의 계약.
- **needs-check**: 이번 세션에서 해당 동작의 완료까지 확인하지 못함.

## 우선 수정할 결함

### F1 · P1 · 빈 페이지 토큰 때문에 파일 조회와 신규 데이터 업로드가 막힘

**verified / 실제 실행**

파일 저장소에서 네 버킷 모두 동일하게 재현했다.

| 동일한 버킷 목록 요청 | 결과 |
|---|---|
| `?bucket=…&prefix=&token=` | HTTP 500 |
| `?bucket=…&prefix=` | HTTP 200 |

CloudWatch 오류는 `InvalidArgument: The continuation token provided is incorrect`이다. 목록이 비어 있는 것이 아니다.

[S3Browser.tsx](../../dashboard/web/src/components/storage/S3Browser.tsx#L38)는 첫 페이지에도 `token=`을 보낸다. API의 query helper는 빈 문자열을 보존하고, [s3.ts:30](../../dashboard/web/src/server/aws/s3.ts#L30)이 이를 AWS `ContinuationToken`에 전달한다.

영향은 파일 저장소에 그치지 않는다. [DatasetDetailPage.tsx:105](../../dashboard/web/src/components/pages/DatasetDetailPage.tsx#L105)도 같은 요청을 만들고, PENDING 버전은 S3 목록을 직접 읽는다. 업로드 입력은 `fileListingQuery.data`가 있을 때만 표시된다(429, 466행).

실제 UI에서 데이터셋 생성 → 새 버전 생성 → PENDING까지 진행했지만, 목록 오류로 파일 선택 입력이 아예 없었다. 업로드·확정·다운로드 시나리오는 여기서 차단됐다. 테스트 데이터셋은 UI로 삭제하고 GET 404까지 확인했다.

**수정 방향:** 클라이언트에서 빈 토큰을 생략하고 서버에서도 빈 문자열을 `undefined`로 정규화한다. 파일 업로드·재개 입력은 목록 조회 성공 여부와 분리한다. S3의 불투명 페이지 토큰은 URL 인코딩도 적용해야 한다.

근거: [요청 비교](evidence/2026-09-18-ui-infra-audit/reproductions.json), [서버 로그](evidence/2026-09-18-ui-infra-audit/storage-errors.json), [업로드 차단 화면](evidence/2026-09-18-ui-infra-audit/flow-failure-dataset-create-upload-finalize-download.png).

### F2 · P1 · 관리자도 플랫폼 설정 화면을 열 수 없음

**verified / 실제 실행**

같은 인증 세션에서 `/api/me`는 `role=admin`, `/api/admin/users`는 200인데 `/admin` 화면은 `Admin role required`를 표시한다.

[AdminPage.tsx:63–67](../../dashboard/web/src/components/pages/AdminPage.tsx#L63)은 `useMe()`의 query 객체를 `any`로 바꾸고 `me.role`을 읽는다. 실제 역할은 `me.data.role`이다. 이 분기가 항상 권한 없음 화면을 반환하므로 사용자·감사 로그·설정·비용 탭에 접근할 수 없다.

**수정 방향:** `any`를 제거하고 로딩·조회 실패·역할 판정을 분리한다. 관리자 로그인으로 각 탭의 실제 내용까지 확인하는 브라우저 테스트를 추가한다.

근거: [실제 화면](evidence/2026-09-18-ui-infra-audit/page-admin.png), [API와 UI 비교](evidence/2026-09-18-ui-infra-audit/reproductions.json).

### F3 · P1 · 실제 HyperPod providerID를 인식하지 못해 노드 축소가 차단됨

**verified / AWS 인벤토리 + 소스 검증. 실제 축소는 실행하지 않음.**

실제 GPU 노드의 값은 다음과 같다. CPU 노드 두 개도 같은 형식이다.

```text
InstanceId: i-0f190b8fa232cef49
providerID: aws:///use1-az4/sagemaker/cluster/hyperpod-tqci9uwuwqiz-i-0f190b8fa232cef49
```

[scaling-activity.ts:52](../../dashboard/web/src/server/services/scaling-activity.ts#L52)는 providerID 마지막 `/` 뒤 문자열이 InstanceId와 완전히 같아야 한다고 가정한다. 실제 세 노드에 이 판정을 적용하면 모두 false다. 따라서 `node_mapping_unknown`이 발생하고 노드 축소를 차단한다. 정책을 저장하거나 충분히 기다려도 이 식별 오류는 해소되지 않는다.

**수정 방향:** HyperPod와 일반 EC2/EKS의 providerID 형식을 명시적으로 처리하고, cluster·instance·node UID를 함께 확인한다. 충돌하는 providerID를 단순 노드 이름으로 덮어쓰지 않는다. 실제 providerID fixture를 회귀 테스트에 넣는다.

현재 저장된 축소 정책은 없으므로 자동 축소가 이미 운영 중이라는 뜻은 아니다.

### F4 · P1 · SageMaker 요청 복구 worker에 실행 권한이 빠짐

**verified / 배포 IAM 시뮬레이션 + 소스 검증. 장애를 유발하지 않음.**

실제 파이프라인 ARN에 대한 IAM 시뮬레이션 결과:

| 역할 | `sagemaker:StartPipelineExecution` |
|---|---|
| 웹 API 역할 | allowed |
| controller 역할 | implicitDeny |

필요한 context 값을 제공한 비교에서도 MissingContextValues는 비어 있다.

[dashboard-stack.ts:267](../../dashboard/infra/lib/dashboard-stack.ts#L267)은 GR00T 스택에 `PipelineName` Output이 있을 때만 controller에 권한을 준다. 실제 GR00T 스택에는 그 Output이 없다. 같은 파일 276행의 다른 권한과 환경 설정은 이름을 fallback으로 계산하므로 웹에서의 정상 제출과 복구 경로의 권한이 달라진다.

[pipelines.ts:63–83](../../dashboard/web/src/server/services/pipelines.ts#L63)과 [worker.ts:114](../../dashboard/web/src/worker.ts#L114)는 미확정 intent를 동일한 AWS client token으로 다시 제출해 복구하도록 설계돼 있다. 웹 프로세스가 AWS 접수와 실행 기록 저장 사이에서 중단되면 controller가 이 복구를 수행할 권한이 없다.

**수정 방향:** 파이프라인 이름/ARN을 한 번만 계산해 환경 변수와 양쪽 역할의 정책에 공통 사용한다. 복구 시험에는 웹 역할과 다른 controller 역할을 사용한다.

근거: [실제 IAM 비교](evidence/2026-09-18-ui-infra-audit/pipeline-iam-comparison.json).

### F5 · P2 · SageMaker 실행 화면의 표시값과 제출값이 다름

**verified / 배포 UI에서 조작하고 제출 요청을 로컬 가로채기로 확인. AWS 학습을 시작하지 않음.**

[PipelinesPage.tsx:204–228](../../dashboard/web/src/components/pages/PipelinesPage.tsx#L204)에서 다음을 재현했다.

1. 데이터셋과 인스턴스를 다른 값으로 입력한 후 **Quick 검증 설정**을 누르면 두 값이 기본 데이터셋과 `ml.g5.12xlarge`로 돌아간다. preset이 기존 formData를 대체한다.
2. `MaxSteps`를 지우면 화면에는 `100`이 다시 보이지만 제출 payload는 `MaxSteps: ""`이다. 서버의 정수 검증은 이를 거절한다.
3. 실제 기본값이 숫자 0인 `NumGpus`는 빈 입력으로 보인다. `||`가 유효한 0을 제거한다.

**수정 방향:** preset은 지정한 학습 파라미터만 갱신하고, 기본값은 form state에 정규화한다. 화면 값과 요청 값을 같은 데이터에서 생성하며 0과 빈 문자열을 구별한다.

근거: [입력·payload 비교](evidence/2026-09-18-ui-infra-audit/pipeline-form.json).

### F6 · P2 · 파이프라인 학습 상세가 실제 파인튜닝 대신 SmokeEval을 표시함

**verified / 실제 실행 상세 화면 + 소스 검증**

과거 성공 실행 `olsvzf6o2fuv`의 `Training Job` 패널에는 다음이 표시된다.

```text
pipelines-olsvzf6o2fuv-SmokeEval-w90MHflcV9
Instance Type: ml.g6.4xlarge
Model Artifacts: …/smoke-eval/…/output/model.tar.gz
```

[PipelineExecutionPage.tsx:143](../../dashboard/web/src/components/pages/PipelineExecutionPage.tsx#L143)은 `Metadata.TrainingJob`이 있는 첫 단계만 선택한다. 이 파이프라인에서는 GR00TFinetune과 SmokeEval 모두 Training Job이므로 AWS가 반환한 순서에 따라 smoke 작업이 선택된다. 단계 테이블에서 다른 단계를 펼쳐도 하단 학습 패널의 선택 기준은 바뀌지 않는다.

**수정 방향:** 학습 역할/단계 이름으로 기본값을 선택하고, 여러 Training Job이 있을 때 사용자가 명시적으로 전환할 수 있게 한다.

### F7 · P2 · 기본 검증 명령이 실패하며 기존 smoke 검사가 위 결함들을 놓침

**verified / 이번 세션 재실행**

`npm test`는 10개 테스트가 실패한다. 실패한 세 파일은 공통 설정의 `DASHBOARD_ORIGIN`과 각 fixture의 Origin이 달라 403을 받는다. 각 파일에 맞는 Origin으로만 바꿔 별도 실행하면 17개 테스트 모두 통과한다. 제품 코드 변경 없이 원인을 분리한 결과이며, 기본 테스트 명령이 통과한 것은 아니다.

[vitest.setup.ts:6](../../dashboard/web/vitest.setup.ts#L6)의 공통 도메인과 다음 fixture가 충돌한다.

- `templates.test.ts`: `http://localhost`
- `topology-preview.test.ts`: `https://app.example`
- `backends/routing.test.ts`: `https://dashboard.test`

[smoke.spec.ts:29](../../dashboard/web/e2e/smoke.spec.ts#L29)의 페이지 검사는 제목 존재와 일부 401 문구만 확인한다. F1의 500 화면과 F2의 관리자 거부 화면도 제목이 있어 통과할 수 있다. 신규 페이지 일부는 순회 대상에도 없다. multipart E2E는 API로 업로드하므로 F1의 사라진 파일 입력을 검증하지 못한다.

**수정 방향:** fixture별 Origin을 일관되게 설정하고, 페이지별 주요 내용·실패 응답·핵심 사용자 동작을 검사한다.

## 구조 판단: 배포 자원은 연결하지만 두 실행 경로를 명확히 구분해야 함

기존 스택 Output을 `dashboard/infra/bin/app.ts`가 **CDK synth 시점**에 읽고 ECS 환경 변수로 주입한다. 요청할 때마다 부모 스택을 새로 발견하는 구조는 아니다. 배포 인프라를 전혀 모르는 구현은 아니지만, F3·F4처럼 실제 리소스 형식과 코드 계약이 어긋난 부분이 있다.

| 경로 | 실제 실행 방식 | 데이터·상태 경로 | 이번 확인 |
|---|---|---|---|
| `/workflows`의 GR00T·MuJoCo·Isaac Lab DAG | 웹 → DynamoDB/Step Functions/SQS → controller → HyperPod EKS의 Job/JobSet, Kueue | 프로젝트 namespace/queue, 고정 S3 입력, FSx 작업 경로, S3 READY 산출물 | CPU 작업 실제 완료, GPU 레시피 사전 점검 |
| `/pipelines`의 GR00T SageMaker Pipeline | SageMaker Processing Job → Training Job → smoke Training Job → Condition/ModelPackage | 별도 SageMaker 역할, GR00T S3 버킷, MLflow, 대시보드 소유권 기록 | 정의·이력·UI·정책 확인. 현재 V2 전체 실행은 미검증 |
| HyperPod Slurm | 별도 Slurm 클러스터 | 별도 FSx/S3 | 인벤토리·컴퓨트 표시. 대시보드 DAG 제출 대상은 아님 |
| DCV | 별도 기존 EC2 워크스테이션 + 세션 gateway | Cognito와 만료되는 브라우저 연결 | iframe 데스크톱 렌더링·연결 종료 통과 |

이 분리 자체는 타당하다. 다만 두 실행 경로에 같은 “GR00T 전체 파이프라인” 표현을 사용하면 실행 위치·사용 데이터·큐·결과 등록 방식이 같다고 오해하기 쉽다. 실행 전에 **SageMaker 관리형 작업인지 HyperPod EKS 작업인지**, 실제 데이터 원본과 인스턴스/큐를 보여주는 것이 필요하다.

### 실제 HyperPod 및 대시보드 자원

| 자원 | 확인된 배포 |
|---|---|
| HyperPod EKS / EKS 클러스터 | `hyperpod-eks-913524902871`, Kubernetes 1.34 |
| EKS 노드 | `ml.c5.4xlarge` 2대 + `ml.g5.8xlarge` 1대, 모두 Ready/Schedulable |
| 노드 공급 | EKS managed node group 없이 HyperPod가 공급 |
| 스케줄링 | Kueue, JobSet v0.12.0; 프로젝트 workshop은 team-a namespace/LocalQueue |
| EKS FSx | `fs-042f63b1f254c0087`, 1,200 GiB, PERSISTENT_2 |
| Slurm | `hyperpod-913524902871`, head/CPU worker/GPU worker/GPU debug 노드; 큰 GPU 그룹들은 0대 |
| Slurm FSx | `fs-0c2e901f6987efc26`, 1,200 GiB, PERSISTENT_2 |
| 대시보드 | EKS VPC 안의 web/controller/gateway Fargate 서비스, 각각 1개 실행 |
| 추가 backend | 배포 allowlist가 빈 배열. 기본 EKS만 실제 연결 |
| DCV | `i-048cffe4cd6ad4f3e`, 실행 중인 별도 `g5.4xlarge` 워크스테이션 |

FSx Export UI의 `/fsx/checkpoints`는 서버에서 `checkpoints`로 변환한다. 실제 DRA의 `/checkpoints`와 AWS의 mount point 상대경로 계약에 맞으므로 결함으로 분류하지 않았다.

### 실제 SageMaker Pipeline 정의

파이프라인은 `groot-sm-finetuning-913524902871`, 현재 **V2**, 마지막 정의 변경은 **2026-09-16 21:37:05 UTC**이다.

| 단계 | 실제 서비스 작업 | 현재 정의 |
|---|---|---|
| TransformDataset | Processing Job | `ml.m5.2xlarge` 1대, 100 GB 볼륨, 30일 캐시 |
| GR00TFinetune | Training Job | 기본 `ml.g5.12xlarge` 1대, 30 GB 볼륨, 최대 24시간 |
| SmokeEval | Training Job | 기본 `ml.g5.2xlarge` 1대, 100 GB 볼륨, 최대 1시간 |
| SmokeGate | Condition | S3 보고서의 `smoke.passed` 판정 |
| 성공 분기 | ModelPackage 등록 | `PendingManualApproval` |
| 실패 분기 | Fail 단계 | `SmokeFailed` |

학습과 smoke는 `groot-sm-training:latest` 이미지, `GR00TSageMakerRole-913524902871-us-east-1`, `groot-sm-artifacts-913524902871-us-east-1` 버킷을 공유한다. HyperPod GPU나 Kueue 할당량을 사용하는 경로가 아니다. 입력도 대시보드 READY dataset/FSx 대신 **HF 데이터셋 → 전처리 S3 출력**이다.

서버가 주입하는 `DashboardProjectId`/`DashboardOwnerSubject`는 소유권 기록·MLflow 태깅에 사용된다. 프로젝트별 IAM 역할·네트워크·컴퓨트 격리를 생성하지는 않는다. 또한 EKS 작업의 이미지 digest 고정과 달리 native 파이프라인은 `:latest`이므로 동일 파이프라인 버전만으로 동일 이미지 실행을 보장할 수 없다.

AWS 전체 이력은 8개(성공 1, 실패 3, 중단 4)이고 기본 UI는 프로젝트 기록 4개를 보여준다. 이것은 조회 범위 차이이며 네 실행을 누락한 버그로 분류하지 않았다.

**V2로 실행된 이력은 없다.** 과거 성공 실행 `olsvzf6o2fuv`는 선택 실행·이전 학습 산출물 재사용이 포함돼 있다. 최신 EKS GR00T DAG의 성공 이력과도 별개다. 따라서 현재 SageMaker 정의의 새 데이터 전처리부터 Registry 등록까지 전 과정이 검증됐다고 표시하면 안 된다.

## 추가 소스 검토 사항

아래는 실제 운영에서 해당 변경/실패 상황을 유발하지 않았다.

| 항목 | 근거·영향 | 검증 범위 |
|---|---|---|
| 모호한 SageMaker 제출 실패 후 중복 실행 위험 | [PipelinesPage.tsx:89](../../dashboard/web/src/components/pages/PipelinesPage.tsx#L89)는 실행 dialog를 다시 열 때 idempotency key를 교체한다. AWS 접수 후 응답/기록이 유실된 요청과 동일 입력을 다시 제출하면 새 실행으로 처리될 수 있다. | 소스 검증. 서버는 동일 키 재사용을 요구함 |
| 추가 backend readiness와 역할 분리의 충돌 | [probe.ts:46](../../dashboard/web/src/server/backends/probe.ts#L46)은 web/controller probing에도 exec/port-forward 등을 요구하지만 [apply_addons.py](../../dashboard/infra/ops/apply_addons.py#L69)는 이를 gateway 역할에 분리한다. priorityclasses discovery 권한도 맞지 않는다. | 소스 검증. 현재 추가 backend 없음 |
| standalone task topology 미반영 | [schema.ts:105](../../dashboard/web/src/server/workflow/schema.ts#L105)의 task-level required topology가 standalone Job 컴파일에는 반영되지 않는다. 해당 값 유무에 따라 동일 manifest가 생성됨. resource-level topology와는 별개다. | 메모리 내 compiler 비교 |
| controller 소스/배포 크기 차이 | 실행 중 task는 CPU 512 units / 메모리 1 GiB, [현재 소스 기본값](../../dashboard/infra/lib/constructs/service.ts#L159)은 2048 / 4 GiB. | AWS 조회. 이번 실행의 장애 원인으로 단정하지 않음 |
| 프로젝트 변경과 열린 입력 폼 | 프로젝트 선택은 공유 cookie를 바꾸고 현재 탭만 reload한다. 다른 탭에서 열린 제출 폼은 이전 프로젝트를 표시할 수 있으며 파이프라인 요청은 명시적 project header를 보내지 않는다. | 소스 검증. 현재 단일 프로젝트 환경에서 교차 프로젝트 재현은 하지 않음 |

## 이번 실행 검증 범위

| 기능 | 결과와 한계 |
|---|---|
| Cognito 로그인, `/api/me` | 관리자 세션 확인 |
| 최상위 화면 22개 | 모두 HTTP 200으로 렌더링. `/admin`, `/storage`는 위 의미적 결함 확인. HTTP 200은 기능 PASS와 다름 |
| 워크플로 생성 UI | custom, MuJoCo CPU quick, GR00T EKS, Isaac Lab의 실제 사전 점검 응답 확인. 경고 확인 전 실행 버튼 비활성 확인 |
| custom CPU 워크플로 | `ef625dfd5600b755`: UI 제출 → 실제 EKS 실행 → SUCCEEDED → READY JSON 산출물 표시 통과 |
| CPU 학습→평가 | `de2aa487a34e3266`: UI에서 512 steps / 환경 1개 / 평가 2회 설정 → 학습→평가→결과 게시→SUCCEEDED. 파일 19개, 영상 2개 확인 |
| 워크플로 상세 | DAG/Tasks/Logs/Events/Metrics/Spec/Artifacts 탭 표시와 호출 확인. 비어 있는 로그의 무손실 수집까지 검증한 것은 아님 |
| 신규 데이터셋 | 생성/PENDING 통과, 목록 오류 때문에 UI 업로드 차단. 테스트 데이터셋 삭제/404 확인 |
| SageMaker Pipeline | 프로젝트 실행 4개의 상세 조회 통과. 입력값 불일치 재현. 새 GPU 실행은 하지 않음 |
| DCV | 기존 데스크톱 iframe/canvas, framing policy, 내 연결 종료 실제 통과 |
| 모델·평가 | 이번 CPU 학습 출력으로 UI 모델 등록→평가 보고서 연결→기준 확인 통과. 평가 2회에 최소 20회 기준을 적용하면 review/approved=false이고 승인 버튼이 비활성. GR00T의 자동 평가 실행은 호환 launch profile이 없다는 제한이 표시됨. 품질 승인·Registry 변경은 실행하지 않음 |
| 메트릭·실험·사용량 | 현재 API/차트 표시 확인. 실제 청구액과 프로젝트 추정의 일치까지 검증한 것은 아님 |
| 컴퓨트·큐·backend | AWS 자원과 UI 대조. 노드 수 변경, 추가 backend 등록은 실행하지 않음 |
| 접근 관리·이미지·빌드·웹훅·엣지 | 화면/조회 API와 코드 검토. credential rotation, 이미지 build/승인, webhook 실제 수신, 물리 장치 배포는 이번에 실행하지 않음 |
| 장애 복구·대용량 | 이번에 프로세스 장애, checkpoint resume, 대용량 업로드를 새로 유발하지 않음. 이전 보고서의 성공을 이번 검증으로 재사용하지 않음 |

학습→평가 실행은 약 5분 15초 걸렸다. 평가 영상은 metadata 조회에서 멈추지 않고 브라우저에서 실제 재생했다. 확인 시점에 `currentTime=1.88s`, `readyState=4`, 640×480이었고 디코딩 오류는 없었다.

생성한 모델은 `mdl-4b30c8271947005451a13393`, 평가 기록은 `eval-281de434123007765b52909d`이다. 모델 이름은 `UI audit 2026-09-18 CPU`이다. 표본 부족 판정을 확인했으며 품질 승인은 만들지 않았다.

완료된 두 테스트 실행과 모델·평가·게시 산출물은 검증 이력으로 남긴다. 업로드 차단을 확인한 별도 PENDING 데이터셋은 UI로 삭제했다. 새 SageMaker GPU 학습, 노드 증감, 인프라 배포, 물리 장치 배포는 수행하지 않았다.

근거: [CPU 실행](evidence/2026-09-18-ui-infra-audit/cpu-training.json), [영상 재생](evidence/2026-09-18-ui-infra-audit/video-playback.json), [실제 영상 프레임](evidence/2026-09-18-ui-infra-audit/evaluation-playing.png), [모델·평가 검증](evidence/2026-09-18-ui-infra-audit/model-flow.json).

### 로컬 검사

| 명령 | 실제 결과 |
|---|---|
| `dashboard/web: npm test` | 160 파일 중 156 통과 / 3 실패 / 1 skip. 테스트 1,187 통과 / 10 실패 / 2 skip |
| Origin 원인 분리 | 실패 세 파일을 각각 올바른 Origin으로 실행: 총 17 테스트 통과 |
| `npm run typecheck` | 통과 |
| `npm run build` | 통과 |
| `npm run build:services` | 통과 |
| `dashboard/infra: npm run build` | 통과 |
| infra Node 테스트 | 6개 통과 |
| 배포 DCV embed E2E | 1개 통과 |

검증 증거는 [evidence 디렉터리](evidence/2026-09-18-ui-infra-audit)에 보존한다. 인증 cookie, 로그인 비밀번호, presigned 다운로드 URL은 보존 대상에서 제외했다.

## 수정 및 재검증 순서

1. F1/F2를 고치고 관리자 탭·파일 저장소·신규 dataset 업로드→READY→다운로드를 실제 UI로 재검증한다.
2. F3/F4의 리소스 계약을 고친 뒤 검토된 용량 계획과 동일 intent 복구를 해당 운영 역할로 검증한다.
3. 파이프라인 입력값/선택 단계/재시도 키를 고치고, 실제 실행 위치와 정의 버전·이미지 digest를 UI에 표시한다.
4. 현재 SageMaker V2에 대해 별도 작은 전체 실행을 수행한다. 전처리/학습/smoke/Registry/대시보드 archive를 각각 확인한다.
5. 기본 테스트 명령과 브라우저 검증을 정상화하고 나머지 모델·장비별 시나리오를 명시적으로 검증한다. 모두 완료되기 전에는 전체 기능 검증 완료로 표시하지 않는다.

공식 계약을 확인한 자료(documented, 2026-09-18 확인):

- AWS, `Running jobs on SageMaker HyperPod clusters orchestrated by Amazon EKS`: `https://docs.aws.amazon.com/sagemaker/latest/dg/sagemaker-hyperpod-eks-run-jobs.html`
- AWS FSx, `CreateDataRepositoryTask`의 Paths 계약: `https://docs.aws.amazon.com/fsx/latest/APIReference/API_CreateDataRepositoryTask.html`
