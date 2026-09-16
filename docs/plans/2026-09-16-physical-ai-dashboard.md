# Physical AI Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. 아래 체크박스는 실제 결과와 증거를 확인한 뒤 갱신한다.

**Goal:** 연구자가 웹에서 데이터·학습·평가·시뮬레이션·모델·자원 관리를 수행하는 AWS 기반 대시보드를 구현하고 us-east-1에서 실제 검증한다.

**Architecture:** Next.js/Cognito/ALB 제어 UI와 별도 실행 controller·session gateway를 기존 EKS VPC의 ECS Fargate에 둔다. Step Functions/SQS/DynamoDB로 실행 수명을 관리하고 HyperPod EKS/Kueue 및 SageMaker를 실행 backend로 연결한다.

**Tech Stack:** Next.js **16.3.5**, TypeScript, React, AWS CDK v2, AWS SDK, ECS Fargate, Cognito, ALB, Step Functions Standard, SQS, DynamoDB, S3, FSx, AMP, CloudWatch, MLflow.

**Spec:** [설계와 기능 대응표](../designs/2026-09-16-physical-ai-dashboard.md)

**Status:** 승인 후 구현 진행 중. 핵심 AWS 경로의 배포·실측 검증과 원본 브랜치 통합을 마쳤다. [통합 검증 기록](../reports/2026-09-16-release3-integration.md)과 [기능별 남은 과제](../reports/2026-09-16-feature-evidence.md)를 기준으로 계속 보완한다.

## Global Constraints

- Next.js 버전은 정확히 `16.3.5`로 고정한다.
- 배포 대상은 계정 `913524902871`, 리전 `us-east-1`이다.
- 기존 사용자 변경 파일과 부모 CDK 스택의 리소스 소유권을 보존한다.
- 통합 구현 루트는 `dashboard/`다. 조사 도중 나타난 `dashboard/web/`의 작성 상태와 계약을 먼저 확인한다.
- 표준 사용자 제출은 project namespace/queue/role/storage 경계를 반드시 거친다.
- 운영 화면의 backend 장애·미구현 기능·비어 있는 결과를 샘플 데이터로 채우지 않는다.
- 기능 `F01`–`F42`의 구현과 검증 상태를 별도로 추적한다.
- model access·추가 GPU profile·실물 장치가 필요한 검증은 실제 수행 여부를 명시한다.
- 배포 권한은 원 요청에 포함된다. 설계 검토 뒤 동일 범위의 배포 권한을 반복 요청하지 않는다.

## 파일 구성

| 경로 (`dashboard/` 기준) | 책임 |
|---|---|
| `web/src/app/` | 페이지와 HTTP route |
| `web/src/features/` | workflow, datasets, experiments, models, sessions, compute, devices UI |
| `web/src/server/` | ALB identity 검증, 인가, API 조합 |
| `services/controller/` | DAG scheduling, 실행기 adapter, lease·watch·복구 |
| `services/session-gateway/` | WebSocket, terminal, task app proxy, SSM/DCV |
| `services/task-runtime/` | 준비 barrier, 입력/결과 전송, checkpoint, task heartbeat |
| `packages/contracts/` | 공개 schema, event/reason code, capability, API 모델 |
| `packages/aws/` | scoped AWS clients, config, persistence, observability |
| `packages/cli/` | 실행·조회·동기화·port-forward용 CLI |
| `packages/mcp/` | 추가 자동화 도구. 같은 API 인가 경로 사용 |
| `recipes/` | 검증된 버전별 workflow와 parameter schema |
| `images/` | task runtime와 학습·시뮬레이션 이미지 |
| `infra/` | 독립 extension CDK app과 add-on 배포 |
| `scripts/` | discovery, preflight, deploy, smoke, cleanup |
| `tests/` | 계약·엔진·adapter·통합·브라우저 검증 |
| `docs/feature-matrix.md` | 기능별 구현 상태와 증거 링크 |
| `docs/deployment-evidence/` | 실제 배포와 테스트 증거 |

## 공통 계약

API는 변경 작업에 idempotency key를 받고 `202 { operationId, runId }`를 반환한다. 실패는 `{ code, message, details, retryable, requestId }` 형식이다.

```ts
type EvaluationKind = "smoke" | "open-loop" | "simulation" | "benchmark" | "hardware";
type RunPhase = "VALIDATING" | "QUEUED" | "INITIALIZING" | "RUNNING"
  | "FINALIZING" | "SUCCEEDED" | "FAILED" | "CANCELLING" | "CANCELLED";
type AccessRole = "viewer" | "researcher" | "project-admin" | "platform-admin";
type ResourceScope = { projectId: string; backendId: string; namespace: string };
type TaskIdentity = { runId: string; groupId: string; taskId: string; attempt: number };
type ArtifactRef = {
  bucket: string; key: string; versionId: string; sha256: string; bytes: number;
};
```

사용자 spec, 렌더된 spec, backend resource는 서로 다른 타입으로 둔다. namespace/role 등의 신뢰 가능한 배포 정보는 `ResourceScope`와 backend 설정에서 주입한다.

## Task 1: 불변 명세·환경 발견·프로젝트 권한

**Files:** `packages/contracts/{workflow,identity,artifact,capability}.ts`, `packages/aws/{config,repository}.ts`, `web/src/server/{auth,authorization}/`, `scripts/discover.ts`, `tests/{contracts,auth}/`.

**Produces:** typed WorkflowSpec/ResolvedWorkflow, ResourceScope, authenticated principal, immutable revision, capability report.

- [ ] 기존 변경 파일 hash와 stack outputs를 저장한다. 새 `dashboard/web/`의 작성 상태·API·테스트를 검토해 재사용하고 package lock·Node runtime·Next.js 16.3.5를 고정한다. `lib/`를 무시하는 기존 gitignore가 신규 CDK 소스를 누락하지 않는지 확인한다.
- [ ] schema·DAG 검증, parameter rendering, immutable spec hash, project membership 모델을 구현한다.
- [ ] ALB JWT 검증·Origin 검사·project authorization을 구현한다. 로컬 test identity는 배포 환경에서 활성화 불가능하게 한다.
- [ ] 순환 DAG, task 중복, 잘못된 image/resource, 위조 signer, 만료 JWT, 교차 프로젝트 접근에 대한 계약 테스트를 실행한다.
- [ ] F01/F02/F03/F10/F16/F17/F18/F26/F27/F40의 공통 계약을 feature matrix에 연결한다.

**검증 사례:** 동일 idempotency key+동일 spec은 동일 run ID, 다른 spec은 409. viewer 제출은 403. 변조된 projectId로 읽은 객체는 반환하지 않는다.

## Task 2: 실행 원장·DAG 조정·장애 복구

**Files:** `services/controller/{main,reconcile,dag,leases,attempts,cancel,deadlines}.ts`, `packages/aws/{runs,events,operations}.ts`, `tests/controller/`.

**Consumes:** ResolvedWorkflow와 프로젝트 범위. **Produces:** durable Run/GroupAttempt/TaskAttempt, append-only event와 executor command.

- [ ] DDB 조건부 쓰기·lease·launch intent·SQS 재전달 처리를 구현한다.
- [ ] dependency ready set, 병렬 sibling, group leader, ignoreNonleadStatus, exitAction 정책을 구현한다.
- [ ] 그룹별 queue/start/exec deadline, bounded retry, cancellation confirmation과 attempt epoch fencing을 구현한다. operator와 controller의 중첩 retry를 차단한다.
- [ ] SFN callback/heartbeat와 controller restart adoption을 연결하고 terminal state 이후 callback을 durable outbox로 전달한다.
- [ ] 생성 직후 crash, 중복 event, 순서가 뒤집힌 event, lease handover, cancel-vs-complete race를 fault test한다.

**검증 사례:** 두 worker가 같은 메시지를 받아도 외부 task는 1개다. 한 branch가 timeout 나도 독립 branch는 계속된다. 최종 artifact 저장 실패는 SUCCEEDED가 아니다. F04–F09/F19–F21.

## Task 3: EKS 실행기·그룹·거버넌스

**Files:** `services/controller/executors/{kubernetes,jobset,pytorch,mpi,ray}.ts`, `services/controller/governance/`, `infra/addons/`, `services/task-runtime/`, `tests/integration/kubernetes/`.

**Consumes:** executor command, pool profile. **Produces:** namespaced Job/JobSet/PyTorchJob, admission/ready/task events, output manifest.

- [ ] AWS IAM 인증의 private EKS API client와 최소 RBAC를 구현한다.
- [ ] resource profile에서 Job/PyTorchJob/JobSet을 생성하고 모든 경로에 project/queue/attempt 라벨을 적용한다.
- [ ] JobSet CRD/controller를 현재 Kueue와 테스트한다. Ray adapter용 KubeRay도 독립 배포로 검증한다.
- [ ] task runtime의 data initialization·barrier·checkpoint·최종 upload·SIGTERM 처리를 구현한다.
- [ ] namespace 우회 거부, queue admission, worker failure, 재배치 후 UID 변경, 그룹 barrier, topology를 통합 테스트한다.

**주의:** AWS 관리형 ClusterQueue/LocalQueue를 직접 수정하는 관리 UI를 만들지 않는다. gang admission과 application barrier를 각각 검증한다. F05/F06/F09–F14/F18/F22/F28.

## Task 4: S3 데이터·FSx 작업공간·레시피 자산

**Files:** `packages/aws/{datasets,uploads,artifacts,storage}.ts`, `services/task-runtime/data/`, `web/src/features/datasets/`, `tests/integration/storage/`.

**Produces:** DatasetVersion, 완성된 ArtifactRef, upload progress, manifest validation result.

- [ ] project/run/attempt 경로와 immutable dataset manifest, version/tag 조회를 구현한다.
- [ ] presigned multipart upload, complete 검증, checksum·크기 검사, pagination을 구현한다.
- [ ] FSx 프로젝트 디렉터리/UID/GID/subPath, 선택 EFS Access Point와 storage readiness를 연결한다.
- [ ] LeRobot episode/modality/embodiment 검증과 이미지·영상·JSON·Parquet metadata preview를 구현한다.
- [ ] partial upload, 삭제 전파, export 지연, 경로 탈출, 다른 프로젝트 데이터 접근을 테스트한다.

**검증 사례:** DRA 파일 삭제가 별도 보존한 dashboard artifact manifest/version을 삭제하지 않는다. 업로드 미완료 데이터는 학습 입력으로 선택되지 않는다. F14–F17/F24/F32–F34.

## Task 5: 학습·평가 adapter와 재현 가능한 recipe

**Files:** `services/controller/executors/sagemaker.ts`, `recipes/{mujoco,isaaclab,groot,openpi,sdg,cosmos,ros}/`, `images/`, `services/task-runtime/evaluation/`, `tests/recipes/`.

**Produces:** 실제 학습·평가 recipe와 Evaluation, ModelVersion, MLflow provenance.

- [ ] MuJoCo 중간 checkpoint와 normalization stats를 짝지어 저장하고 run별 output 경로를 적용한다.
- [ ] Isaac Lab Reach/Lift/H1 입력, GPU profile, resume/playback adapter를 구현한다.
- [ ] 기존 GR00T Pipeline API·로그·artifact를 연결하고 실제 폐루프 결과 JSON 수집을 추가한다.
- [ ] 실제 OpenPI 학습 구현, SDG/Mimic/Cosmos/LeRobot 변환 recipe를 작성하고 capability/model-access preflight를 적용한다.
- [ ] recipe별 최소 실제 실행을 검증한다. 합성 평가 예제나 placeholder는 품질 지표로 사용하지 않는다.

**검증 사례:** source/dataset/image/checkpoint가 고정된 재실행, smoke와 simulation 평가의 다른 gate, worker 중단 후 resume. F28–F34/F38–F40.

## Task 6: 로그·학습 메트릭·실험 비교·모델 승인

**Files:** `packages/aws/{cloudwatch,amp,mlflow,models}.ts`, `web/src/features/{runs,experiments,models}/`, `tests/observability/`.

**Consumes:** run identity, namespace, tracking server, metric schema. **Produces:** cursor log stream, timeseries, comparison, promotion decision.

- [ ] CloudWatch/Kubernetes log cursor와 SSE heartbeat/reconnect, error reason을 구현한다.
- [ ] AMP의 검증된 query template을 run/project로 scope하고 metric units·aggregation·timestamp를 표시한다.
- [ ] MLflow API로 params·metrics·artifacts를 읽고 EKS task의 tracking instrumentation을 연결한다.
- [ ] 평가 유형별 모델 승격 policy를 구현한다. 누락 metric과 실패한 품질 검증의 처리 규칙을 명시한다.
- [ ] 실제 실험 2개 비교, 빈 series, API 장애, 오래된 데이터, 장시간 idle stream을 검증한다.

**검증 사례:** GPU 노드가 없을 때 GPU utilization 0%를 만들어내지 않는다. shape smoke 통과와 simulation 성공률 통과를 구별한다. F19/F20/F25/F38/F39/F41.

## Task 7: 터미널·파일 동기화·원격 앱

**Files:** `services/session-gateway/{auth,terminal,port-forward,proxy,tickets}.ts`, `packages/cli/sync/`, `web/src/features/sessions/`, `tests/sessions/`.

**Produces:** scoped Session과 single-use launch ticket, authenticated WebSocket, transferred-file manifest.

- [ ] 세션 소유권·현재 task attempt epoch·TTL·원자적 ticket 소비를 검증하는 gateway를 구현한다.
- [ ] terminal resize·disconnect·session 종료와 Kubernetes exec/port-forward를 연결한다.
- [ ] 별도 wildcard app origin에서 notebook/code-server/TensorBoard/Ray 접근을 구현한다.
- [ ] 브라우저 파일 전송과 CLI upload/download/watch daemon, 전송 진행률·재개를 구현한다.
- [ ] session ticket 재사용, sibling-origin의 cookie 충돌·CSRF, 다른 사용자 세션, stale Pod, WebSocket 재연결·권한 폐기 시 연결 종료를 테스트한다.

**검증 사례:** notebook JS가 대시보드 API를 동일 origin으로 호출할 수 없다. 존재하지 않는 원격 파일은 성공으로 처리되지 않는다. F22–F24/F26.

## Task 8: DCV·시뮬레이터 세션·컴퓨트 관리

**Files:** `services/session-gateway/dcv/`, `services/controller/{sessions,capacity}/`, `infra/ssm/`, `web/src/features/compute/`, `tests/dcv/`.

**Produces:** 실제 실행 node에 묶인 DCV 세션, capacity Operation, cleanup evidence.

- [ ] imported workstation과 HyperPod node의 SSM/DCV 상태를 구분해 발견한다.
- [ ] dashboard 관리 세션에 OS/DCV 소유자·session ID 매핑, external authentication, 인증서 검증, 소유 gateway replica별 SSM tunnel lifecycle을 구현한다.
- [ ] 시뮬레이터 Job의 nodeName과 DCV instance를 정확히 연결하고 X11 권한을 검사한다.
- [ ] scale operation의 baseline·최댓값·활성 workload·동시 변경·idle TTL 검사를 구현한다.
- [ ] GPU 2대 환경에서 맞는 화면 연결, 다른 사용자 차단, 세션 만료, 준비 실패, 안전한 capacity 복구를 테스트한다.

**검증 사례:** 학습이 다른 GPU에 배치됐을 때 첫 노드로 접속하지 않는다. 기존 활성 DCV 세션·사용자 인증 설정을 무조건 덮어쓰지 않는다. F10/F11/F25/F35/F41.

## Task 9: 연구자 UI 통합

**Files:** `web/src/app/`, `web/src/features/`, `web/src/components/`, `tests/e2e/`.

**Consumes:** 검증된 API와 실제 backend result. **Produces:** 완성된 연구자 사용자 흐름.

- [ ] frontend-design 스킬을 적용해 화면 방향·typography·정보 구조를 정하고 반응형 shell을 구현한다.
- [ ] 레시피 선택 → 파라미터 → preflight → 제출 → 실행 상세 → 평가 → 모델 승격 흐름을 연결한다.
- [ ] DAG/YAML 편집, 로그·차트·파일·세션을 실행 상세의 일관된 ID로 연결한다.
- [ ] dataset/experiment/model/compute/project 관리와 loading/empty/error/stale 상태를 완성한다.
- [ ] Playwright로 키보드 접근·폼 오류·취소·재실행·다른 프로젝트 권한·모바일 상태 조회를 검증한다.

**검증 사례:** UI에서 성공한 제출은 실제 외부 작업 ID와 연결된다. 실행할 수 없는 기능은 조건과 상태를 정확히 표시한다. F01–F03/F15/F19–F27/F29–F41.

## Task 10: 디바이스·HIL·API/CLI 확장

**Files:** `services/controller/devices/`, `packages/{cli,mcp}/`, `recipes/{greengrass,hil}/`, `web/src/features/devices/`, `tests/edge/`.

**Produces:** DeviceLease, deployment version, Benchmark Evaluation, external automation clients.

- [ ] Greengrass component version/architecture·rollout·rollback·상태 adapter를 구현한다.
- [ ] benchmark JSON 영구 저장, inference가 실제 선택된 엔진을 사용하는지 검증하는 provenance를 구현한다.
- [ ] ROS 2 discovery와 실제 데이터 경로를 잇는 HIL recipe·device lease·timeout을 구현한다.
- [ ] CLI/API token scope·만료·폐기, webhook, 추가 MCP adapter를 공통 인가 계층에 연결한다.
- [ ] 가상 디바이스 end-to-end 테스트와 실제 Jetson 필요 조건을 구분해 결과를 남긴다.

**검증 사례:** 두 실험이 같은 exclusive device를 동시에 점유하지 않는다. 잘못된 amd64 artifact를 arm64 디바이스에 배포하지 않는다. F13/F24/F26/F36/F37/F42.

## Task 11: CDK·이미지 빌드·us-east-1 배포

**Files:** `infra/{bin,lib}/`, `scripts/{preflight,deploy,smoke,cleanup}.ts`, `docs/deployment-evidence/`.

**Produces:** CDK stack, HTTPS URL, outputs, 배포 image digest, 재현 가능한 배포 절차.

- [ ] 비용 메모를 기준으로 신규 resource만 생성하는 extension stack과 explicit import resolver를 구현한다.
- [ ] Cognito/ACM/ALB/DNS, private Fargate, IAM/RBAC, S3/DDB/SQS/SFN, log retention을 합성한다.
- [ ] build/typecheck/lint, CDK assertions/synth, IAM·storage·network 정책 검사를 실행한다. 근거 있는 예외만 기록한다.
- [ ] CDK diff에서 parent replacement·공개 데이터·과도한 권한 변경을 검사하고 실제 배포한다.
- [ ] target health, HTTPS/Cognito login, controller SQS 및 EKS access, startup/healthcheck를 확인한다.

**실행 명령 계약:** 구현 시 package script `build`, `typecheck`, `lint`, `test`, `test:integration`, `test:e2e`, `infra:synth`, `infra:diff`, `deploy`, `smoke`, `cleanup:smoke`를 제공하고 root README에서 재현 가능하게 한다.

## Task 12: 실제 연구 경로 검증·복구·인계

**Files:** `tests/e2e/live/`, `scripts/smoke.ts`, `scripts/cleanup.ts`, `docs/feature-matrix.md`, `docs/deployment-evidence/`.

- [ ] 실제 Cognito test user로 HTTPS 로그인·위조 헤더·교차 프로젝트 접근·logout을 검증한다.
- [ ] 웹에서 CPU RL, GPU RL/resume/DCV, 2-node 최소 학습, GR00T quick pipeline, 로그·지표·artifact를 검증한다.
- [ ] SDG, ROS 2, file sync, 모델 gate, virtual edge를 실행하고 외부 model/hardware 조건별 상태를 기록한다.
- [ ] controller restart, 중복 제출, queue timeout, 실행 취소, session 만료를 실 환경에서 검증하고 테스트 소유 자원을 정리한다.
- [ ] 전체 F01–F42 matrix를 코드·테스트·AWS 증거와 대조해 누락을 해결한다. 최종 URL·비용·검증 범위·실물 조건·운영 종료 절차를 보고한다.

실제 검증이 없는 행을 “AWS 실측 검증”으로 올리지 않는다. 미충족 항목이 남으면 전체 OSMO 동등 구현 완료로 보고하지 않는다.
