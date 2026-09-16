# Physical AI 연구자 대시보드 설계안

상태: **승인 후 구현 진행 중. 핵심 경로를 us-east-1에 배포·실측 검증했고, 전체 기능 대응표의 남은 소프트웨어 항목을 보완 중이다.** 최초 조사 내용은 당시의 상태로 유지한다. 현재 배포는 [통합 검증 기록](../reports/2026-09-16-release3-integration.md), 기능별 차이는 [구현·검증 대응표](../reports/2026-09-16-feature-evidence.md)를 기준으로 확인한다.

조사일: 2026-09-16. 대상 리전: `us-east-1`.

## 1. 목표와 완료의 의미

연구자가 AWS CLI, kubectl, SSM 포트 포워딩, 서로 다른 로그 화면을 조합하지 않고 데이터 준비 → 학습 → 평가 → 시뮬레이션 → 모델 등록·배포를 수행한다. Next.js **16.3.5**를 정확히 고정하고 Cognito와 ALB를 사용한다. 기존 HyperPod EKS, FSx, SageMaker Pipeline, MLflow, Isaac Lab 워크스테이션을 연결한다.

OSMO 비교 기준은 조사 시 GitHub Releases에서 확인한 최신 비프리릴리스 **6.3.1**이다. `main` 문서에만 있는 기능은 릴리스 기능과 구분한다. 예를 들어 MCP 문서 경로는 `main`에는 존재하지만 조사한 `6.3.1` 경로는 404였으므로, MCP는 추가 확장 기능으로 분류한다.

기능 목록의 각 항목은 `계획 / 구현 / 계약 검증 / AWS 실측 검증 / 외부 조건 필요` 상태와 증거를 가진다. 메뉴, 샘플 데이터, YAML 템플릿의 존재만으로 기능 완료를 선언하지 않는다. 전체 목표는 아래 기능군을 구현하는 것이며 첫 배포만으로 범위를 축소하지 않는다.

기능 동등성은 AWS에서 같은 연구자 작업을 수행하는 것을 뜻한다. OSMO API의 바이너리 호환, NVIDIA KAI와 완전히 동일한 스케줄링 결정, 다른 클라우드의 관리 API까지 복제한다는 뜻으로 사용하지 않는다. 해당 차이는 가져오기 검증 결과와 기능 대응표에 표시한다.

## 2. 확인한 현재 환경

`aws sts`, CloudFormation, EKS, SageMaker, EC2, FSx, Route 53, ACM, Kubernetes API를 읽기 전용으로 조회했다. 기존 kubeconfig를 변경하지 않고 `/tmp/physical-ai-dashboard-research.kubeconfig`를 사용했다.

| 항목 | 확인 결과 |
|---|---|
| 저장소 | `aws-physical-ai-recipes`, 브랜치 `feat/hyperpod-dashboard`, 조사 시작 HEAD `748a3f5` |
| 워크숍 | `/home/ubuntu/workspace/physical-ai-on-aws/content` |
| 배포 계정 | `913524902871` |
| EKS 스택 / 클러스터 | `HyperPodEks-913524902871` / `hyperpod-eks-913524902871` |
| EKS / HyperPod 상태 | EKS `ACTIVE`, Kubernetes `1.34`; HyperPod `InService` |
| 노드 | `cpu-c5-4x`: 현재·목표 2대. `gpu-g5-8x`: 현재·목표 0대. CPU 노드 2대 모두 Ready |
| GPU 할당량 | `ml.g5.8xlarge for cluster usage`: 4, 코드 `L-1619F5B7`. 할당량은 실제 AZ 용량 확보와 별개 |
| EKS VPC | `vpc-07b3e827aa8ba7f88`, `10.0.0.0/16`, public/private API endpoint |
| Isaac Lab VPC | `vpc-084d697f391238243`, **동일한 `10.0.0.0/16`** |
| 기존 DCV | `IsaacLab-Latest-913524902871`, `i-048cffe4cd6ad4f3e`, `g5.4xlarge`, running |
| FSx | `fs-042f63b1f254c0087`, AVAILABLE, SSD 1,200 GiB, PERSISTENT_2, 125 MB/s/TiB |
| 학습 S3 | `hyperpod-eks-data-913524902871-us-east-1` |
| 관측 | AMP `ws-25f09b6a-7cb7-45e0-a5d1-89426f633555`; Grafana 및 로그 수집 Deployment 정상 |
| 거버넌스 | add-on `v1.6.0-eksbuild.1`, ACTIVE; 공식 대응 Kueue 버전 `0.19.2` |
| 큐 | `hyperpod-ns-team-a`, `hyperpod-ns-team-b` 각각 LocalQueue/ClusterQueue 존재 |
| 실행기 | batch Job, PyTorchJob, MPIJob 사용 가능. JobSet·Ray CRD는 현재 없음 |
| Kueue 설정 | JobSet/Ray integration 이름 존재. `TopologyAwareScheduling: true`, `DisableWaitForPodsReady: true` |
| GR00T Pipeline | `groot-sm-finetuning-913524902871` 실제 등록 확인 |
| GR00T 아티팩트 / MLflow | `groot-sm-artifacts-913524902871-us-east-1` / `groot-mlflow-913524902871` |
| 도메인 제안 | 기존 public zone `hi-yoo.com`의 `physical-ai.hi-yoo.com`; 해당 이름의 기존 레코드는 조회되지 않음 |
| TLS | 위 새 이름을 포함하는 기존 인증서는 확인되지 않음. 새 ACM DNS 검증 인증서 생성 필요 |
| Next.js | npm `next@16.3.5` 확인. Node 요구사항 `>=20.9.0`, 로컬 Node `22.19.0` |

기존 변경 파일은 보존한다:

- `e2e-workshop/groot/config.yaml`
- `e2e-workshop/groot/training/container/Dockerfile`
- `e2e-workshop/infra/isaaclab/assets/workshop/Dockerfile`
- `e2e-workshop/infra/isaaclab/lib/constructs/az-selector.ts`
- 미추적 `e2e-workshop/groot/training/container/Dockerfile.bak`

조사 도중 최초 inventory에는 없던 `dashboard/web/` 소스가 새로 나타났다. 이 세션과 읽기 전용 조사 에이전트가 생성한 코드는 아니다. 작성 중인 다른 세션 여부를 확인하는 질문을 보냈다. 후속 구현은 **`dashboard/`를 통합 대상**으로 삼고, 먼저 새 코드의 계약·작성 상태를 확인한다. 다른 작성자가 작업 중인 파일을 덮어쓰거나 두 번째 대시보드를 병렬로 만들지 않는다.

부모 스택의 재배포는 기본 절차에 포함하지 않는다. 기존 스택 재배포는 스크립트로 변경된 노드 수, AZ 선택, 사용자 설정을 되돌릴 수 있다. 이 문서와 구현 계획은 저장소가 `docs/superpowers/`를 ignore하므로 추적 가능한 `docs/designs/`, `docs/plans/`에 저장한다.

## 3. 접근 방식 비교와 선택

| 접근 | 장점 | 고려사항 |
|---|---|---|
| **AWS 서비스 중심 제어 계층 + 기존 실행 환경 연결 — 제안안** | 요청한 인증·웹 UX, SageMaker와 EKS 통합, 실행 이력·데이터 계보를 일관되게 제공 | DAG 실행·재시도·세션·권한 의미를 직접 구현하고 검증해야 함 |
| OSMO 6.3.1을 EKS에 설치하고 AWS 관리형 저장소 연결 | OSMO 고유 실행 의미와 기존 UI 기능을 빠르게 활용 | OSMO 제어 서비스·스케줄러 운영이 추가되고 현재 HyperPod 거버넌스 및 독립 SageMaker 워크숍 통합 필요 |
| SageMaker Pipeline/Studio 중심 포털 | 기존 GR00T 흐름 재사용 용이 | 일반 EKS 작업 그룹, ROS 2/HIL, DCV, 실행 중 파일 동기화에 별도 제어 계층 필요 |

제안안을 기준으로 아래 명세를 작성했다.

## 4. 구성과 책임

| 구성 | 책임 |
|---|---|
| Route 53 + ACM + ALB | HTTPS, Cognito 로그인 연결, 웹·세션 게이트웨이 라우팅 |
| Cognito User Pool | 사용자 로그인, 관리형 로그인 화면, 향후 조직 IdP 연동 기반 |
| Next.js 16.3.5 / ECS Fargate | 연구자 UI, 서버 API, 요청 검증, 프로젝트 권한, 짧은 작업 응답 |
| 별도 controller / ECS Fargate | DAG 의존성, Kueue admission, 시도·시간제한·재시도, Kubernetes watch, SageMaker 실행 동기화 |
| Step Functions Standard | 전체 실행의 수명과 제어 서비스 callback, 감사 가능한 실행 상태 |
| SQS + DLQ | 실행·취소·조정 요청 전달. 중복 수신을 정상 조건으로 취급 |
| DynamoDB | 프로젝트 권한, 실행·시도·작업 상태, 이벤트, lease, artifact manifest, 세션 메타데이터 |
| session gateway / ECS Fargate | WebSocket 터미널, 작업 포트 연결, DCV SSM 터널, 짧은 연결 ticket 검증 |
| HyperPod EKS + Kueue | CPU/GPU 작업, 분산 학습, 시뮬레이션, 큐·자원 할당 |
| SageMaker Pipeline / Training / Model Registry | GR00T 및 별도 SageMaker 학습 어댑터, pipeline 단계·모델 버전 관리 |
| S3 + FSx for Lustre | S3는 내구성 있는 데이터·결과, FSx는 고속 학습 작업 공간 |
| 선택 EFS | 영속 notebook 홈 디렉터리가 필요한 경우 Access Point 단위로 사용 |
| AMP + CloudWatch + MLflow | 인프라 지표, 로그, 실험 파라미터·학습 곡선·모델 계보 |
| ECR + CodeBuild | 불변 이미지 빌드, digest·소스 commit 추적 |
| Secrets Manager + IAM / Pod Identity | HF/NGC 등 외부 자격증명, AWS 역할 기반 접근 |
| IoT Greengrass / 필요 시 IoT 통신 | 엣지 배포·상태·벤치마크·HIL 확장 |

기존 EKS VPC의 private subnet에 제어 서비스를 둔다. Fargate를 사용해 학습 GPU 용량이 0이어도 대시보드가 살아 있도록 한다. 동일 CIDR의 기존 Isaac Lab VPC와는 VPC peering을 가정하지 않는다. 기존 워크스테이션 접근은 SSM을 통해 연결하고 데이터는 S3로 전달한다.

Step Functions의 직접 `eks:runJob.sync`는 public Kubernetes endpoint 및 batch Job 중심이고 상태 확인 주기도 연구자 UI에 비해 길다[A2]. 따라서 `SQS waitForTaskToken`과 VPC 안의 controller를 사용한다. SFN은 전체 실행 수명, DynamoDB/controller는 세부 DAG 상태의 권위 있는 원장으로 책임을 나눈다.

## 5. 인증·프로젝트 격리·세션

1. ALB HTTPS listener에 Cognito authorization-code 인증을 설정한다. Client secret, callback `/oauth2/idpresponse`, scope와 logout 경로를 CDK로 함께 구성한다[A1].
2. 서버는 `x-amzn-oidc-data`의 ES256 서명, 예상 ALB signer ARN, issuer, client, 만료를 검증한다. unsigned identity 헤더만으로 사용자를 신뢰하지 않는다. 앱 타깃은 ALB security group에서만 접근 가능하게 한다.
3. 프로젝트 membership은 검증된 Cognito `sub`에 연결한다. `viewer`, `researcher`, `project-admin`, `platform-admin` 역할을 사용한다. 플랫폼 권한과 일상 학습 제출 역할을 분리한다.
4. namespace, queue, backend, IAM role, storage prefix는 서버가 프로젝트 설정에서 결정한다. 클라이언트가 보낸 namespace/role ARN을 그대로 사용하지 않는다.
5. 모든 변경 요청에 Origin/CSRF 검증을 적용한다. 대량 취소는 선택한 실행을 명시하고 권한을 각 실행에 검사한다.
6. notebook·code-server·사용자 HTTP 앱은 대시보드와 별도 origin인 `<session-id>.apps.physical-ai.hi-yoo.com`에서 제공한다. 임의의 notebook JavaScript가 대시보드 인증 영역에 들어오지 않도록 한다.
7. 앱 접속 ticket은 로그인된 대시보드 API가 발급한다. gateway에서 사용자·세션·hostname·attempt epoch·60초 유효기간·원자적인 일회용 소비를 검사하고 host-only Secure/HttpOnly 쿠키로 교환한 뒤 URL에서 ticket을 제거한다. AWS 자격증명과 SFN task token은 브라우저에 전달하지 않는다.
8. `/api/*`는 JSON 인증 오류를 처리하고, 페이지는 로그인으로 이동한다. 세션 만료, 재로그인, logout 이후 재접속까지 테스트한다.
9. 세션 URL, proxy 대상, Kubernetes subresource는 서버 등록 정보로만 결정한다. 일반 임의 URL 프록시를 제공하지 않는다. SSM/DCV 인증 자료는 애플리케이션 로그에서 제거한다.
10. 기본 shared FSx PVC는 테넌트 격리를 제공하지 않는다. 신뢰된 provisioning 작업이 프로젝트별 디렉터리·UID/GID를 만들고, 서버가 고정한 `subPath`, read-only 공용 데이터셋, non-root 실행·capability 제한을 조합한다. workload의 광범위한 node IAM credentials 접근도 차단한다. 관리자 전용 host mount/privileged 레시피는 별도 compute/storage 신뢰 경계로 운영한다.
11. sibling origin은 같은 site일 수 있으므로 SameSite만을 CSRF 방어로 사용하지 않는다. dashboard cookie를 host-only로 제한하고 가능한 앱 쿠키는 `__Host-` 규칙을 사용한다. 중복·충돌하는 인증 쿠키, WebSocket Origin, revocation 이후 기존 연결 종료를 검증한다.

## 6. OSMO 기능 대응 및 검증 기준

표의 구현 항목은 모두 **계획 상태**다. 근거 `N*`, `A*`, `L*`는 마지막 절에 있다.

| ID | OSMO 기능·연구자 요구 | AWS 기반 구현 | 완료 검증 |
|---|---|---|---|
| F01 | 워크플로우 제출, 검색, 상세, 버전 이동 | DAG 화면·실행 필터·pagination·불변 spec snapshot | 브라우저 제출 결과와 실제 backend ID 일치 |
| F02 | YAML/JSON과 파라미터화 템플릿[N2,N8] | schema 검증, YAML 편집기, template renderer, 렌더 결과 미리보기 | 순환 DAG·누락 참조·위험 옵션 거부 |
| F03 | Apps 생성·공유·버전·기본값[N8] | 프로젝트별 recipe catalog, immutable revision, 설명형 입력 폼 | 과거 revision으로 재실행 재현 |
| F04 | 직렬·병렬·복합 DAG | 의존성 기반 ready set, fan-out/fan-in, 결과 manifest 연결 | 병렬 sibling과 join의 성공·실패 테스트 |
| F05 | 그룹, leader, `ignoreNonleadStatus`[N2] | JobSet 또는 특화 PyTorchJob, 그룹 의미를 controller가 관리 | 비leader 실패/leader 종료/그룹 재시작 각각 검증 |
| F06 | 시작 barrier[N3] | 준비된 모든 task의 초기화 완료 handshake 후 실행 시작 | 느린 이미지·데이터 준비 중 조기 학습 시작 없음 |
| F07 | 그룹별 queue/exec/start timeout[N3] | 그룹 전환 시각 기준 deadline, 장애 사유·downstream 전파 | 한 그룹 timeout 중 독립 sibling 지속 |
| F08 | exitActions, reschedule, retry[N4] | exit code 범위 정책, attempt 번호, 제한된 backoff | 중복 범위 거부, 사용자 오류/선점 구분 |
| F09 | checkpoint 주기·최종 업로드[N4] | task runtime의 주기 업로드, checksum manifest, 마지막 일관 checkpoint | 중단·선점 후 올바른 checkpoint에서 재개 |
| F10 | CPU/GPU/메모리/디스크/플랫폼[N5] | typed resource profile, arch/GPU/드라이버/VRAM readiness 검사 | 불가능한 요청을 제출 전에 설명 |
| F11 | node exclusion, topology[N5] | node affinity, 검증된 Kueue topology key, required/preferred | 실제 node label·배치 결과 증거 |
| F12 | 우선순위·pool quota·borrowing·preemption[N6] | HyperPod SchedulerConfig/ComputeQuota, Kueue admission 상태 | 큐 우회 차단, quota·대기 사유·선점 복구 확인 |
| F13 | 여러 backend/pool | 등록된 AWS 계정·리전·EKS backend별 adapter와 역할 | backend별 조회·제출 격리, 접근 불가 상태 구분 |
| F14 | 데이터 입력·출력과 필터[N7] | S3, FSx/EFS workspace, artifact manifest, 전송 진행률 | 업로드 끝나기 전 결과 READY가 되지 않음 |
| F15 | 데이터 버전·태그·탐색 | S3 VersionId/checksum 기반 dataset registry | 재현 가능한 version pin, 삭제 영향 명시 |
| F16 | 로컬·인라인 파일 주입[N2,N7] | 브라우저 multipart 업로드, 파일 경로 검증, script/config injection | 경로 탈출·symlink 공격 및 크기 제한 검증 |
| F17 | 자격증명·private registry[N9] | Secrets Manager 참조, ECR IAM, 실행 시 제한된 secret injection | 다른 프로젝트 secret 거부, 로그 노출 검사 |
| F18 | host mounts·hostNetwork·privileged[N2] | platform-admin이 승인한 recipe profile만 사용 | 일반 연구자 임의 host 경로·권한 상승 거부 |
| F19 | 로그·에러·이벤트 스트림 | CloudWatch/Kubernetes 로그, cursor 기반 SSE, reconnect | 60초 이상 조용한 스트림·재연결·중복 처리 |
| F20 | 작업 상태·실패 진단 | backend 원문과 연구자 설명, pending reason, 재시도 이력 | API 장애와 실제 작업 실패를 다르게 표시 |
| F21 | 작업 취소·대량 취소[N1] | durable cancel intent, 자식 작업·세션 종료 확인 | SFN 중지 뒤 살아 있는 GPU 작업이 남지 않음 |
| F22 | 브라우저 exec[N10] | xterm 기반 terminal, resize, WebSocket, 접속 audit | 프로젝트/attempt 권한, 재스케줄 뒤 이전 Pod 접속 차단 |
| F23 | port-forward·원격 앱[N10] | 등록된 task port, 별도 origin gateway, notebook/code-server/Ray UI | HTTP·WebSocket·정적 자산·쿠키 경로 테스트 |
| F24 | 파일 upload/download·rsync daemon[N10] | 브라우저 전송과 CLI 동기화 agent, 진행률·체크섬 | 동기화·중단 재개·없는 원격 파일 오류 |
| F25 | 자원·pool 점유 화면 | AMP 기반 GPU·CPU·메모리·queue·할당량 그래프 | 실제 series와 일치, GPU 0대는 N/A로 표시 |
| F26 | 역할·정책·서비스 token[N11] | Cognito identity, project RBAC, scope·만료·폐기 가능한 CLI token | 권한 변경·토큰 폐기·다른 프로젝트 접근 검사 |
| F27 | config·pod/group template·resource validation | 버전 관리된 관리자 profile, 변경 diff, capability preflight | 미지원 backend 옵션을 조용히 무시하지 않음 |
| F28 | 분산 torchrun/DeepSpeed·Ray[N12] | PyTorchJob/MPIJob/JobSet, 선택 KubeRay, EFA capability | 2-node 최소 학습, checkpoint/worker failure 회복 |
| F29 | Isaac Lab RL·MuJoCo[L1,L2] | 검증된 task/seed/env/iteration 폼, 학습→평가 recipe | CPU RL와 GPU RL 실제 실행·보상·영상 |
| F30 | GR00T 파인튜닝[L3] | 기존 SageMaker Pipeline 시작·중단·단계·로그·등록 연계 | 실제 quick run의 training·smoke·model artifact |
| F31 | π0/OpenPI 연구자 요구[L4] | 공식 OpenPI 기반 실제 학습 adapter와 image 추가 | 저장소의 현재 예제 placeholder를 완료로 취급하지 않음 |
| F32 | Isaac Sim synthetic data[N12] | Replicator headless recipe, sensor modalities·seed·scene 입력 | 생성 이미지·depth/segmentation manifest 검증 |
| F33 | Mimic·Cosmos·LeRobot 변환[N12] | 단계별 데이터 변환·증강·학습 recipe와 이미지 capability | 각 단계 아티팩트 계약 및 필요한 GPU/model access 검사 |
| F34 | 실제 폐루프 평가[L5] | policy server와 simulator 그룹, 영구 evaluation JSON, videos | 라운드별 성공·timeout·seed·checkpoint 기록 |
| F35 | Isaac Sim/DCV 시각화[L2,A4] | 실제 배치 node에 연결된 DCV 세션, 수명·ownership 관리 | 로그인 후 데스크톱·렌더링·만료·다른 사용자 차단 |
| F36 | ROS 2 / HIL[N13] | ROS discovery/data-path recipe, 디바이스 lease, Greengrass 배포 | 가상 장치 E2E와 실제 Jetson 검증을 구분 |
| F37 | 엣지 benchmark·inference[L6] | component version·rollout·rollback·상태, latency JSON | 실제 엔진 사용 여부와 p50/p95/p99 저장 |
| F38 | 실험 비교·모델 계보 | MLflow API adapter, 동일 축 metric 비교, dataset→run→model→eval | 실험 2개 실제 비교, 누락 metric을 0으로 채우지 않음 |
| F39 | 모델 승격·품질 gate | smoke/평가/지연시간 유형 구분, 설정 가능한 gate, Registry 연계 | smoke 성공만으로 로봇 성능 승인하지 않음 |
| F40 | 코드·이미지 재현성과 빌드 | CodeBuild/ECR, commit/digest, 빌드 로그·실패 진단 | 동일 recipe revision의 출처 추적 |
| F41 | 사용량·비용·idle 관리 | 예상 GPU-hours, 가격 timestamp, session TTL, 비용 태그 | 예상과 청구 데이터를 구분, active 작업 강제 회수 방지 |
| F42 | API·CLI·외부 자동화 | versioned REST, CLI, service token, webhook; 추가 MCP adapter | UI와 동일한 인가·idempotency·오류 형식 |

### 기능 동등성을 위한 주의사항

- OSMO 6.3의 기존 Dataset API는 폐기 예정으로 표시되어 있다[N1]. 연구자에게 필요한 버전·태그·계보 기능은 S3 manifest 기반으로 유지한다.
- OSMO의 LOW/HIGH/NORMAL borrowing 규칙과 현재 HyperPod 정책이 같다고 가정하지 않는다. UI에서 AWS 정책의 실제 보장량·차용량·선점 가능성을 보여주고 가져오기 시 의미 차이를 보고한다.
- Kubernetes JobSet은 controller/CRD 설치가 별도로 필요하다. 조사 시 최신 release `v0.12.0`, KubeRay `v1.7.0`을 확인했으나 EKS 1.34·현재 Kueue 조합의 호환성은 통합 테스트로 확정한다.
- 현재 Kueue의 JobSet integration 설정만으로 JobSet이 실행되는 것은 아니다. quota admission, Pod 준비, 애플리케이션 barrier는 각각 검증한다.
- 외부 storage URI의 입력/출력 요구는 AWS에서 실행하는 connector job으로 대응 가능하지만 해당 서비스 credentials와 계약 검증이 필요하다. 미구현 scheme은 명시적 오류를 반환한다.
- HIL 장치, gated model, H100급 모델 레시피는 실제 장치·모델 접근·GPU 프로필이 필요하다. AWS에 웹 배포가 끝났다는 이유로 해당 하드웨어 테스트까지 완료했다고 표시하지 않는다.

## 7. 연구자 화면과 UX

기본 UI는 한국어이며 task ID, 모델 이름, metric 이름은 원문을 유지한다. AWS 식별자는 상세 패널에서 확인할 수 있게 한다.

| 화면 | 연구자가 하는 일 |
|---|---|
| 개요 | 진행 중 실험, 막힌 단계, 준비된 데이터, 가용 자원, 최근 결과 확인 |
| 레시피 | MuJoCo, Isaac Lab Reach/Lift/H1, GR00T, OpenPI, SDG, ROS/HIL 등 실행 가능한 template 선택 |
| 파이프라인 | DAG 편집·파라미터 입력·검증·예상 자원 확인·실행 |
| 실행 상세 | 그래프, 단계/attempt, 로그, GPU 및 학습 지표, 파일, 재시도·취소 |
| 데이터셋 | 업로드, version/tag, episode·modality·embodiment 검증, 이미지·영상 preview |
| 실험 비교 | seed/hyperparameter 변경 비교, 학습 곡선, 평가 유형·성공률·지연시간 비교 |
| 모델 | checkpoint, dataset/source 계보, 평가 결과, 승격·내보내기·배포 |
| 시뮬레이션·개발 | DCV, notebook, code-server, TensorBoard, 파일 전송, 세션 종료 |
| 컴퓨트 | pool별 CPU/GPU·quota·대기 사유, 관리자 scale 작업과 진행 상태 |
| 디바이스 | 연결된 edge 장치, 배포 버전, benchmark, HIL lease |
| 프로젝트·관리 | 사용자 권한, backend 연결, secret 참조, resource profile, 감사·비용 |

모든 주요 화면에 loading/empty/error/stale-data 상태를 구현한다. 새 프로젝트에는 실행 안내를 보여주고 실제 데이터처럼 보이는 샘플 실험을 삽입하지 않는다. 위험 작업의 영향과 진행 중 작업을 화면에 명시한다. 키보드 접근, 화면 읽기 label, 대형 로그 virtualization, 모바일에서 상태 조회 가능한 레이아웃을 검증한다.

## 8. 실행 엔진의 규칙

### 식별자와 저장 모델

`projectId / backendId / workflowRevision / runId / groupId / taskId / attempt`를 모든 실행·로그·아티팩트에 사용한다. 추가 provenance는 source commit, image digest, dataset manifest hash, seed, embodiment, checkpoint URI와 평가 유형이다.

주요 엔티티: Project, Membership, Backend, Pool, RecipeRevision, Run, GroupAttempt, TaskAttempt, RunEvent, DatasetVersion, Artifact, Evaluation, ModelVersion, Session, CredentialReference, DeviceLease, Operation.

DynamoDB에는 project/run partition과 시간·상태 조회 인덱스를 설계한다. 목록은 cursor 기반이며 상태 조회가 전체 table scan을 요구하지 않도록 한다. 프로젝트 범위 없는 ID만으로 객체를 읽는 API는 제공하지 않는다.

### 제출·중복·복구

- API는 검증·인가·불변 spec 저장 후 `202`와 `operationId/runId`를 반환한다. 장시간 실행을 Next.js 요청 안에서 기다리지 않는다.
- Idempotency key는 `(projectId, principal, operation)` 범위에서 spec hash와 함께 저장한다. 같은 key에 다른 spec은 409이다.
- controller는 DDB 조건부 쓰기와 lease로 단일 소유자를 보장한다. 외부 작업을 만들기 전 durable launch intent를 기록한다.
- Kubernetes 이름·라벨, SageMaker client request token을 결정적으로 생성한다. controller가 생성 직후 중단되면 다음 인스턴스가 기존 작업을 찾아 채택한다.
- SQS 재전달, watch `410 Gone`, 오래된 event, Pod UID 재사용, lease 만료를 정상적인 복구 경로로 테스트한다.
- SFN task token은 제어 계층만 보관하고 execution attempt에 결합해 heartbeat를 갱신한다. terminal state를 원장에 commit한 뒤 durable outbox로 callback을 전달한다. callback 유실 시 재조정하며 이미 종료된 token에 대한 재시도는 작업을 중복 생성하지 않는다.

### 작업 그룹과 종료

그룹은 leader 1개와 하나의 admission 단위를 가진다. 일반 그룹은 하나의 JobSet, 지원되는 분산 학습은 하나의 PyTorchJob으로 만든다. 서로를 기다리는 구성원을 독립 Job으로 admission하지 않는다. admission 후 image/data 초기화를 완료한 모든 task가 barrier에 도착하면 사용자 프로세스를 시작한다. 준비 단계·실행 단계 timeout을 구분한다. `ignoreNonleadStatus`와 exitActions에 따라 개별 task 재시도 또는 그룹 전체 attempt 재생성을 선택한다.

그룹마다 `attemptEpoch`를 저장한다. 전체 그룹 재시도의 소유자는 dashboard controller로 고정하고 operator의 독립 retry와 중첩되지 않게 설정한다. 새 attempt 시작 전에 이전 epoch를 무효화하고 workload·session·endpoint 종료를 확인한다. barrier 참가, checkpoint/artifact publish, callback은 현재 epoch를 검사해 종료된 attempt가 결과를 덮어쓰지 못하게 한다. Kueue reservation 상태를 직접 patch하지 않고 소유한 workload root를 종료해 해제하도록 한다.

상태는 `VALIDATING → QUEUED → INITIALIZING → RUNNING → FINALIZING → SUCCEEDED`를 기본으로 하고 취소·실패·선점 사유를 별도 reason code로 보존한다. 사용자 코드는 종료됐어도 필수 결과 업로드가 실패하면 성공으로 확정하지 않는다.

취소는 durable intent를 먼저 기록하고 실행기별로 자식 Job/Pod/SageMaker 실행과 세션을 종료한 뒤 확인한다. 선점·실패 후 재시작 전에 동일 GPU 자원을 잡은 이전 attempt가 종료됐는지 확인한다.

## 9. 워크숍 레시피를 제품 기능으로 전환

### MuJoCo

`Workshop-SO101-Reach-MuJoCo-v0`, seed, total steps, vector env 수, checkpoint 주기를 폼으로 제공한다. `model_best.zip`, `model_final.zip`, 정규화 통계, `best_checkpoint.json`, TensorBoard, MP4를 하나의 실행에 연결한다.

현재 정규화 통계의 저장 시점을 보완해 중간 checkpoint와 짝이 맞도록 한다. 평가용 seed/episode 수를 고정하고 학습 최고 보상과 평가 성공률을 구분한다.

### Isaac Lab

Reach/Lift/H1을 명시적 profile로 제공한다. task별 환경 수·iteration·VRAM 요구를 검사한다. 기존 `/fsx/checkpoints/rl` 공유 경로와 변경 가능한 공용 checkout을 run/attempt별 경로 및 image/source revision으로 대체한다.

DCV playback은 실제 Pod의 nodeName에서 HyperPod instance를 해석한다. 첫 GPU 노드를 선택하는 기존 helper의 규칙은 다중 노드 환경에 사용하지 않는다. X11 권한과 DCV 준비 상태를 별도 확인한다.

### GR00T

기존 `TransformDataset → GR00TFinetune → SmokeEval → SmokeGate → RegisterModel/SmokeFailed`를 어댑터로 연결한다. quick preset은 워크숍의 `MaxSteps=100`, batch=4, save=50을 출발점으로 한다. 실제 container/schema에 맞는 파라미터만 전달한다.

SageMaker 실행 ARN, training job, MLflow run, transformed data manifest, model.tar.gz를 연결한다. registered training image를 검증 없이 inference endpoint image로 취급하지 않는다.

### 폐루프 평가와 모델 승격

LeIsaac의 실제 policy server/simulator 경로를 사용하고 라운드별 결과를 영구 JSON으로 남긴다. 현재 `hyperpod-training/examples/vla/eval_closed_loop.py`의 합성 관측·임의 보상 예제는 실제 품질 평가에 사용하지 않는다.

평가 schema는 `type`, task, seed, episode count, success count/rate, timeout, latency quantiles, checkpoint digest, simulator/scene version, video URI를 포함한다. 품질 gate는 유형별로 설정하며 지표 누락은 실패 또는 검토 필요로 처리한다.

### OpenPI·SDG·Cosmos·HIL

OpenPI의 현재 예제는 미완성이다. 공식 구현 기반 이미지와 실제 학습 adapter를 작성해 완료시켜야 한다. 워크숍의 별도 저장소 URL 자리표시자를 존재하는 통합으로 취급하지 않는다.

SDG·Mimic·Cosmos·변환 recipe는 model access, GPU architecture/VRAM, input schema를 metadata에 선언한다. 각 단계의 실제 결과 manifest를 검증하고 리소스 불충족을 실행 전 표시한다.

Greengrass에서는 amd64와 Jetson arm64 artifact를 구분한다. 벤치마크와 inference가 동일 모델/엔진을 사용했는지 기록한다. ROS 2는 discovery 연결뿐 아니라 데이터 전송 경로도 검증한다. 실물 로봇의 자동 동작은 별도 장치 연결과 운영 절차가 갖춰진 경우에만 테스트한다.

## 10. 스토리지·관측·DCV 세부 사항

- 내구성 기준은 dashboard 소유 S3 bucket의 versioned manifest다. 기존 FSx DRA는 삭제 이벤트도 전파하므로 연구 결과 보존을 그 경로만으로 보장하지 않는다.
- 실행 경로는 `projects/<project>/runs/<run>/attempts/<attempt>/`를 사용한다. 최종 artifact는 S3 객체 존재·checksum 검사 후 READY로 확정한다.
- 브라우저 업로드는 제한된 key/크기/유형의 presigned multipart URL을 사용한다. 완료 시 서버가 검증한다. 큰 데이터셋의 목록은 pagination과 manifest로 처리한다.
- GPU/queue 지표는 검증된 query template만 AMP에 보낸다. 프로젝트 namespace 제한을 적용한다. arbitrary PromQL을 일반 사용자 API에 그대로 노출하지 않는다.
- MLflow는 실제 tracking server API를 연결한다. URI만 추가해서 기존 비어 있는 EKS instrumentation이 자동 활성화된다고 가정하지 않는다.
- DCV는 소유자·실행·node·만료와 실제 OS/DCV 사용자·session ID를 묶어 관리한다. 공용 `workspace` 세션을 여러 사용자에게 노출하는 것을 격리된 개인 세션으로 취급하지 않는다. 기존 imported workstation의 활성 세션과 인증 설정을 조사하고, dashboard 관리 세션의 external authentication 구성을 분리·백업한다[A4].
- gateway의 SSM tunnel은 세션별 수명·소유 replica·고유 loopback port·allowlisted target을 기록하고 재연결을 관리한다. 기존 self-signed DCV TLS는 등록된 호스트의 인증서 신뢰/핀 검증으로 처리하고 전역 TLS 검증 해제를 사용하지 않는다.
- scale-down은 active workload, interactive session, filesystem finalization 및 다른 운영자의 capacity 변경을 검사한다. 생성 당시 baseline과 달라진 다른 운영자의 변경을 덮어쓰지 않는다.

## 11. 배포와 실제 테스트

배포는 원 요청에서 승인된 범위다. 이 설계 검토 이후 별도의 포괄적 배포 재승인을 기본 단계로 추가하지 않는다.

1. 기존 resource inventory와 dirty file hash를 기록하고 신규 extension stack만 합성·검토한다.
2. Cognito/ALB/ACM/DNS, Fargate, DDB/SQS/SFN/S3/역할을 CDK로 생성한다. backend import는 명시한 stack 이름과 account/region을 검증한다.
3. 필요한 JobSet/KubeRay와 RBAC를 별도 add-on 배포 단위로 설치한다. AWS 관리형 큐를 직접 덮어쓰지 않는다.
4. HTTPS 외부 접근, 익명 차단, Cognito 실제 로그인, logout, 위조 헤더, 역할·프로젝트 격리를 검증한다.
5. CPU MuJoCo 최소 학습·평가를 웹에서 제출한다. SSE 로그, metric, 영상, S3 manifest, 취소·재시도·controller restart를 확인한다.
6. GPU를 baseline 0에서 필요한 수만큼 올린다. 처음에는 1대, 분산 검증 시 최대 2대를 계획한다. 실제 capacity와 다른 사용자의 작업을 재확인한다.
7. Isaac Lab GPU 학습·체크포인트 재개·DCV playback, 2-node 최소 분산 작업을 수행한다. GPU `nvidia-smi`만으로 학습 성공을 선언하지 않는다.
8. 기존 GR00T Pipeline의 quick 실행, 실제 smoke 결과·artifact·MLflow 연결을 확인한다. 지원 가능한 크기로 실제 폐루프 평가도 수행한다.
9. SDG·ROS 2·원격 개발·파일 동기화·모델 gate·edge virtual device 경로를 검증한다. gated model·H100·실물 Jetson 조건은 별도 시험 기록으로 남긴다.
10. Playwright로 실 배포 URL의 전체 사용자 경로를 테스트한다. 실제 테스트 사용자 자격증명은 저장소나 로그에 남기지 않는다.
11. 테스트에서 추가한 GPU 용량과 임시 job/user/ticket을 정리한다. 기존 데이터·스택·다른 사용자의 실행은 보존한다.
12. 최종 보고에 URL, CDK outputs, image digest, feature matrix 상태, test evidence, 미검증 외부 조건, 실제 비용 모델과 종료 방법을 포함한다.

현재 단계에서 실제 테스트한 것은 AWS 연결·환경 조회이며, 애플리케이션 테스트는 아직 실행하지 않았다.

## 12. 비용

개발 크기의 추가 상시 제어 계층은 **약 $74.62/월**: Fargate 3개 서비스 총 1.25 vCPU/2.5 GiB, ALB 1개 평균 1 LCU, 공인 IPv4 2개, 월 730시간 가정이다.

이는 전체 청구액이 아니다. 기존 EKS/CPU/FSx/MLflow/NAT/DCV, 새 서비스의 데이터·로그·인증·요청 비용, GPU 학습은 별도다. HyperPod `ml.g5.8xlarge`는 조회 가격 기준 **$3.06/시간/노드**다. 2대 × 1.5시간 검증 예시는 GPU compute만 $9.18이며 비용 상한 약속이 아니다.

자세한 산식·조회 provenance·제외 항목: [비용 메모](../research/2026-09-16-physical-ai-dashboard-costs.md).

## 13. 근거

아래 URL은 2026-09-16 조회 기준이다. NVIDIA 자료는 코드 복제가 아닌 동작 명세 분석에 사용했다.

### NVIDIA / framework

- N1: `https://api.github.com/repos/NVIDIA/OSMO/releases?per_page=5` — 최신 release, 6.3 Dataset deprecation, 6.3.1 bulk cancellation.
- N2: `https://raw.githubusercontent.com/NVIDIA/OSMO/6.3.1/docs/user_guide/workflows/specification/index.rst` — task/group schema.
- N3: `https://raw.githubusercontent.com/NVIDIA/OSMO/6.3.1/docs/user_guide/workflows/specification/timeouts.rst` 및 `barriers.rst`.
- N4: 같은 `specification/` 경로의 `checkpointing.rst`, `exit_actions.rst`.
- N5: 같은 경로의 `resources.rst`; `docs/user_guide/resource_pools/scheduling/topology.rst`.
- N6: `https://raw.githubusercontent.com/NVIDIA/OSMO/6.3.1/docs/user_guide/resource_pools/scheduling/index.rst`.
- N7: 같은 `specification/` 경로의 `inputs_and_outputs.rst`, `file_injection.rst`, `templates_and_tokens.rst`, `host_mounts.rst`.
- N8: `https://raw.githubusercontent.com/NVIDIA/OSMO/6.3.1/docs/user_guide/workflows/apps.rst`.
- N9: `https://raw.githubusercontent.com/NVIDIA/OSMO/6.3.1/docs/user_guide/getting_started/credentials.rst`.
- N10: `https://raw.githubusercontent.com/NVIDIA/OSMO/6.3.1/docs/user_guide/workflows/interactive/` 아래 `exec.rst`, `port_forward.rst`, `rsync.rst`.
- N11: `https://raw.githubusercontent.com/NVIDIA/OSMO/6.3.1/docs/deployment_guide/appendix/authentication/roles_policies.rst`.
- N12: `https://raw.githubusercontent.com/NVIDIA/OSMO/6.3.1/cookbook/README.md`, `cookbook/nut_pouring/README.md`, `cookbook/cosmos/transfer/README.md`, `cookbook/groot/groot_mimic/README.md`.
- N13: `https://raw.githubusercontent.com/NVIDIA/OSMO/6.3.1/docs/user_guide/how_to/hil.rst` 및 `ros2_comm.rst`.
- N14: npm `view next@16.3.5 version engines peerDependencies dist.integrity --json`; `https://nextjs.org/docs/app/getting-started/installation.md`.
- N15: `https://api.github.com/repos/kubernetes-sigs/jobset/releases/latest`; `https://api.github.com/repos/ray-project/kuberay/releases/latest`.

### AWS 공식 문서

- A1: `https://docs.aws.amazon.com/elasticloadbalancing/latest/application/listener-authenticate-users.html`
- A2: `https://docs.aws.amazon.com/step-functions/latest/dg/connect-eks.html`
- A3: `https://docs.aws.amazon.com/sagemaker/latest/dg/sagemaker-hyperpod-eks-operate-console-ui-governance-setup-task-governance.html`
- A4: `https://docs.aws.amazon.com/dcv/latest/adminguide/external-authentication.html`
- A5: `https://docs.aws.amazon.com/sagemaker/latest/dg/sagemaker-hyperpod-eks-operate-console-ui-governance-tasks-gang-scheduling.html`

### 로컬 소스

- L1: `hyperpod-training/examples/rl/train_mujoco.py:110`, `play_mujoco.py:175`.
- L2: `hyperpod-training/k8s-templates/rl/isaaclab-train-job.yaml:33`, `isaaclab-play-job.yaml:33`, `hyperpod-training/examples/rl/train_isaaclab.py:194`.
- L3: `e2e-workshop/groot/pipeline/build_pipeline.py:79`, `:188`; `e2e-workshop/groot/training/data/transform_dataset.py:30`.
- L4: `hyperpod-training/examples/vla/train_pi0.py:48`; workshop `content/appendix/pi0-sagemaker/index.ko.md:48`.
- L5: workshop `content/vla-track/module-5-evaluation/index.ko.md:228`; `hyperpod-training/examples/vla/eval_closed_loop.py:239`.
- L6: `e2e-workshop/edge/workshop-components/N1.6/com.workshop.benchmark/recipe.yaml:70`, `com.workshop.inference/recipe.yaml:70`.
- L7: `hyperpod-training/infra/lib/hyperpod-eks-stack.ts:79`, `constructs/eks-control-plane.ts:65`, `constructs/observability.ts:67`.
- L8: `hyperpod-training/infra/lib/constructs/storage.ts:73`; `hyperpod-training/k8s-templates/fsx-pvc.yaml:1`.
- L9: `hyperpod-training/scripts/eks/dcv-target.sh:25`; `e2e-workshop/infra/isaaclab/assets/userdata/dcv-proxy-bridge.sh:39`.
- L10: `hyperpod-training/k8s-templates/render.sh:59`; `hyperpod-training/scripts/eks/create-governance.sh:62`.
