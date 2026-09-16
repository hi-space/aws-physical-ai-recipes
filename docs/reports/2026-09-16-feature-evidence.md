# Physical AI Dashboard 기능별 구현·검증 증거

**Release 4는 데이터·복원·로그·권한 기능을 확장했고, 실제 AWS에서 대용량 checkpoint 복원과 로그 재생을 확인했습니다. F01–F42 전체 완료나 OSMO API 호환을 의미하지 않습니다.**

[현재 배포 증거](evidence/2026-09-16-release4/hotfix-deployment-proof.json)의 소스는 `6792484`, `us-east-1`, 이미지 digest `sha256:8f117e39436c3a91193785f5ad5b6efc91284d9610c31fb7e3474f41cd55caf7`입니다. SourceBuild 실제 검증과 배포 후 token/DCV/로그인/me 4개 검증이 통과했습니다. **기존 10.45 GB GR00T artifact의 native archive→READY dataset→모델 등록도 실제 통과했습니다.** 이는 과거 학습 산출물 재사용 검증입니다.

[승인 설계](../designs/2026-09-16-physical-ai-dashboard.md) · [Release 4 검증 보고서](2026-09-16-release4-validation.md) · [이전 Release 3 실제 결과](2026-09-16-release3-validation.md)

## 상태 기준

- **구현**: 소스와 관련 테스트가 있습니다. 별도 실제 결과가 없으면 AWS에서 검증됐다는 뜻이 아닙니다.
- **부분/조건부**: 명시된 범위만 구현됐거나 이미지·데이터·장비·권한·실제 실행 증거가 더 필요합니다.
- **실제 PASS**: 아래 연결한 실행·receipt·검증 파일의 범위에서 확인했습니다. 과거 실행과 이번 배포 검증을 구분합니다.

## F01–F09: 제출과 실행

| ID | 기능 | 소스·테스트 상태 | 실제 증거와 남은 조건 |
|---|---|---|---|
| F01 | 제출·검색·이력 | 구현: [API·제출][submission], [저장소][repo]의 프로젝트별 검색, idempotency, 복제·재시도·페이지 이동 | CPU 실행·결과 게시 PASS. 모든 과거 필터·브라우저 복구 조합의 실제 검증은 별도입니다. |
| F02 | YAML/JSON·변수·검증 | 구현: [schema][schema], [검증 API][validate]가 데이터·이미지·배치 계획을 검사 | 차단 결과는 제출 불가, 경고는 명시적 확인 필요. 검사 시점의 준비 상태는 자원 예약이나 모델 접근 보장이 아닙니다. |
| F03 | 레시피 공유·불변 버전 | 구현: [템플릿 계약][templates]의 프로젝트 공유, CAS 저장, archive/history, 선택 버전 제출 | 수정된 YAML도 출처 버전·hash·수정 여부를 보존합니다. 공개 OSMO Apps 서비스 호환은 아닙니다. |
| F04 | 직렬·병렬·복합 DAG | 구현: [실행기][execution]의 branch/join/skip과 결과 확정 후 후속 실행 | 일반적인 fan-out/fan-in·실패 분기 전체를 실제 검증한 것은 아닙니다. |
| F05 | 그룹·leader·비leader 상태 | 구현: [JobSet 그룹][groups], [broker][broker]의 단일 admission·전체 그룹 재시도 | 실제 2-node 그룹 실행 PASS. `ignoreNonleadStatus:true`에서 비leader만 독립 재스케줄하는 동작은 미지원입니다. |
| F06 | 초기화·시작 barrier | 구현: [compile][compile], [Go runtime][runtime]이 입력 준비와 동료 대기 후 사용자 코드를 시작 | 실제 hydration·분산 실행 PASS. 모든 이미지 지연/네트워크 장애 조합을 검증한 것은 아닙니다. |
| F07 | queue/start/exec 제한시간 | 구현: [실행기][execution]가 단계별 시계·그룹별 timeout·정리를 분리 | 테스트된 controller 의미이며 OSMO scheduler와 동일한 시계/선점 정책은 아닙니다. |
| F08 | 종료 코드·재시도·RESCHEDULE | 구현: raw exit, wrapper 실패, backoff, 시도별 경로와 이전 Pod 정리 구분 | 실제 exit7 정책과 RESCHEDULE 복원 PASS. 실제 인프라 eviction·선점 복구 증거는 별도입니다. |
| F09 | 주기/최종 checkpoint·복원 | 구현: [multipart protocol][multipart-runtime], [복원][restore], [실제 테스트][large-test]. **1 TiB/파일** 소프트웨어 상한, 64 MiB 초과 multipart | [실제 PASS][large-proof] `4b52f39c9f1a25f5`: **5 GiB + 1 MiB, 81 parts**, 시도1→2 전체 크기/SHA256 복원. 1 TiB 실제 전송·성능은 미검증. MuJoCo optimizer/정규화 복원 증거도 유지하며 모든 시뮬레이터 RNG/trajectory 동일성은 보장하지 않습니다. |

## F10–F18: 자원·데이터·자격증명

| ID | 기능 | 소스·테스트 상태 | 실제 증거와 남은 조건 |
|---|---|---|---|
| F10 | CPU/GPU·이미지 준비 상태 | 구현: [이미지 프로필][images]의 ECR digest/architecture 및 관측 자원 검사 | 내장 7개 프로필 승인·일부 CPU/GPU 실행 PASS. driver/모델/자산 접근 불명은 그대로 표시합니다. |
| F11 | 노드 제외·topology | 구현: [등록 계층 planner][topology]와 관측 배치 확인 | 기본 backend의 zone→hostname, 실제 두 CPU 노드 Gloo PASS. 다른 rack/network 계층은 미검증입니다. |
| F12 | 우선순위·quota·차용·선점 | 부분: Kueue/HyperPod queue 정책을 [컴파일][compile]에 적용 | NVIDIA KAI/LOW-HIGH 정책 복제는 아닙니다. 기존 queue에 ephemeral-storage quota가 없어 [첫 대용량 테스트가 admission 전 취소][quota-proof]됐으며 queue는 변경하지 않았습니다. |
| F13 | 복수 backend/pool | 조건부 구현: [등록·라우팅][backends], backend별 클라이언트·FSx/S3·불변 프로젝트 연결 | 실제 검증은 기본 EKS만. allowlist의 추가 대상도 보존하지만 현재 추가 등록은 없습니다. 현재 계정/us-east-1/도달 가능한 home VPC 밖, Slurm DAG·임의 scheduler는 미지원입니다. |
| F14 | 입력/출력·필터·전송 | 구현: [버전 선택][selection], [runtime 한도][limits], S3↔FSx hydration. 새 버전의 include/exclude는 정확한 상대 파일 또는 `/`로 끝나는 디렉터리 prefix | [65파일 실제 hydration PASS][input-proof] `e3883cd7bf426769`. task 전체 1,024파일·64입력 그룹, URL 64파일/page. include/exclude는 각 128경로, wildcard/일반 YAML 필터·EFS/임의 connector는 미지원입니다. |
| F15 | 버전·탐색·다운로드·전체 계보 | 구현: [참조 원장·전체 이력 검사][references], [버전 고정 다운로드][download], [회귀 테스트][lineage-tests]. READY manifest 및 파일 VersionId/hash 고정 | 삭제는 tombstone이며 물리 purge는 거부합니다. submit/delete는 원자적 guard, legacy 이력은 consistent 전체 scan. 이미 삭제된 과거 metadata는 복구하지 못하며 전체 scan은 O(table)입니다. 모든 이력 관리 경로의 실제 검증을 단정하지 않습니다. |
| F16 | inline 파일·브라우저 업로드 | 구현: 안전한 task.files와 [재개 가능한 multipart][browser-multipart] | 이전 16 MiB+17 B, 3 parts 업로드·재개·SHA PASS. ConfigMap 크기와 CLI 파일 재전송 한도는 별개입니다. |
| F17 | 개인/공유 credential·private registry | 구현: [SSM SecureString 참조][credentials], 명시적 프로젝트 공유, 소유권 검사. API는 값을 반환하지 않음 | private image는 승인된 현재 계정 ECR 범위. 일반 외부 registry 인증·임의 imagePullSecrets는 미지원이며 HF/NGC 모델 권한은 별도입니다. |
| F18 | host mount/network/root/privilege | 조건부 구현: [관리자 신뢰 실행 프로필][trusted]의 불변 버전, 정확한 task/image/node UID·전용 taint·점유 검사 | 현재 Cognito **브라우저 플랫폼 관리자**만 승인/제출 가능. token·일반 연구자 raw privilege는 거부. 승인·barrier·RUNNING 재검사 구현; **실제 전용 노드 구성/privileged 실행은 하지 않았습니다.** 호스트 권한은 sandbox가 아닙니다. |

## F19–F28: 관측·세션·운영

| ID | 기능 | 소스·테스트 상태 | 실제 증거와 남은 조건 |
|---|---|---|---|
| F19 | 로그·cursor·SSE 재연결 | 구현: [불변 로그 archive][logs], [HTTP/SSE][logs-http], [브라우저 회귀][logs-test], CLI cursor 재생. attempt/Pod UID/container/restart별 분리 | [실제 PASS][log-proof] `663accac8b444e5a`: SSE 2회 연결, secret 제거, 중복/빈 줄/일반 URL 보존, Pod 삭제 후 재생. **수집한 byte만** 보장하며 미수집·rotation·재연결 간격은 gap으로 표시합니다. 프로세스 처음부터 끝까지 무손실 보장은 아닙니다. |
| F20 | 상태·오류·대기·시도 이력 | 구현: [실행기][execution]가 FINALIZING/취소·복구 실패와 실제 종료를 분리 | 실제 queue·publication·복원 경로 증거 유지. 공급자 오류를 성공/빈 목록으로 바꾸지 않으며 모든 장애의 live coverage는 아닙니다. |
| F21 | 취소·일괄 취소 | 구현: durable 취소 의도·Pod/세션 정리, [SageMaker 별도 중단][pipelines] | 소유 테스트 작업 정리 및 이전 native 중단 확인. API 수락만으로 child 종료를 선언하지 않습니다. |
| F22 | 브라우저 terminal/exec | 구현: [세션][sessions]·gateway가 현재 attempt/실제 Pod UID/소유권을 확인 | 기존 terminal/file 실제 PASS. trusted task는 현재 브라우저 관리자와 실제 시작 상태가 필요하며 token은 거부합니다. |
| F23 | port-forward·격리 앱 | 구현: [gateway][gateway], 등록 port, Jupyter/code-server/TensorBoard | 별도 HTTPS origin/세션 수명 검사. 범용 네트워크 tunnel·Ray manager·EFS Access Point 구현은 아닙니다. hostNetwork HTTP/files는 거부합니다. |
| F24 | 파일 전송·CLI sync/watch | 부분 구현: [Go file service][files], [CLI][cli]의 스트림 전송·원자적 파일 교체·안전 경로 | rsync/block-delta·ranged resume·remote delete 미지원. 중단 시 파일 단위 재전송, active runtime 파일과 완료 archive는 다른 API입니다. |
| F25 | 자원 지표·그래프 | 부분 구현: 프로젝트/queue/attempt 범위 AMP 질의·오류 표시 | AMP/DCGM 모든 실제 label/series 조합 미검증. 계정 전체 지표·비용을 프로젝트 사용량으로 표시하지 않습니다. |
| F26 | 역할·프로젝트·API token | 구현: [token][tokens]의 hash 저장, 최대 30일·scope·프로젝트·현재 Cognito 권한 검사 | Release 4 실제 token 권한 상승 거부·즉시 폐기 PASS. 유한 endpoint allowlist이며 플랫폼 관리자 권한은 위임하지 않습니다. |
| F27 | 관리자 실행/이미지 profile | 조건부 구현: [이미지][images]와 [신뢰 실행][trusted]의 버전·CAS·폐기 및 정확한 명령/입출력 고정 | image 승인과 host 권한 승인은 별개. 실제 privileged node/device 증거는 없으며 임의 Pod template passthrough는 아닙니다. |
| F28 | 분산 학습 | 부분 구현: JobSet/barrier/결정적 DNS와 [2-rank CPU Torch/Gloo][distributed] | 실제 두 노드 all_reduce·optimizer·동일 weight 게시 PASS. EFA/NCCL·전용 Ray/PyTorchJob/MPIJob/DeepSpeed operator·일반 worker-loss 복구는 미검증/미지원입니다. |

## F29–F39: 모델·평가·하드웨어

| ID | 기능 | 소스·테스트 상태 | 실제 증거와 남은 조건 |
|---|---|---|---|
| F29 | MuJoCo/Isaac Lab RL | 구현·조건부: [실제 recipe][recipes]와 checkpoint/평가 adapter | Release 3 MuJoCo 학습·2-episode 평가 및 Isaac SO-101 GPU 학습/비어 있지 않은 영상 PASS. H1/Lift 등 모든 task나 품질 목표 달성 증거는 아닙니다. |
| F30 | GR00T·SageMaker pipeline | 부분: [프로젝트 pipeline][pipelines], [완료 artifact archive][archives], EKS recipe 구현 | 역사적 9/14 성공 실행 `olsvzf6o2fuv`가 `ml4xq8v9ahl6`의 완료 학습 job을 재사용했습니다. 100 steps·약 10.45 GB 실제 산출물 존재. [**기존 산출물 archive→READY dataset v1→모델 등록 실제 PASS(27.2분)**][native-proof]. 새 학습은 아닙니다. 최근 3회 OOM/용량 대기 후 중단은 실패/중단으로 유지합니다. |
| F31 | OpenPI/π0 | 조건부 [recipe][recipes]: 실제 normalization/train 호출·출력/resume | JAX/CUDA·base weights·LIBERO 데이터·VRAM 필요. 실제 학습 및 SO-101 호환은 미검증입니다. |
| F32 | Isaac Sim SDG | 조건부 [recipe][recipes]: USD scene·camera randomization·RGB/depth/semantic 검증 | GPU/driver·카메라·자산/라이선스와 실제 프레임 증거 필요. catalog compile은 센서 정확도 증거가 아닙니다. |
| F33 | Mimic/Cosmos/데이터 변환 | 부분/조건부 [recipe][recipes]: 실제 converter·annotation/generation/inference 진입점 | [Cosmos 선택 이미지 배선][optional-images] 구현. 이미지/weights/고메모리 GPU·scene·실제 실행은 미검증. 생성 영상에서 action/success label을 추정하지 않습니다. |
| F34 | closed-loop 평가 | 부분: MuJoCo rollout, [LeIsaac adapter][leisaac], [tar/directory digest 연결][bundles] 구현 | MuJoCo **2 episodes, REVIEW, approved=false** 유지. 기존 GR00T tar와 31파일 directory bundle의 archive·digest는 실제 확인했으나 평가 report 연결은 로컬 테스트입니다. 실제 GPU closed-loop·물리 로봇 검증은 없음. 20-episode preset은 품질/시간 보장이 아닙니다. |
| F35 | DCV 시각화 | 부분: 등록 workstation·SSM·TLS·Cognito gateway | Release 4 DCV 접속 재검증 PASS. **관리자용 공유 console 한 대**이며 각 workload의 실제 노드에 전용 DCV session을 만드는 기능은 아닙니다. |
| F36 | ROS 2/HIL | 부분: ROS discovery/payload와 [장치 lease][devices] | 기존 실제 20개 메시지 전달·READY 산출물 PASS. lease는 동작 안전 보장이 아니며 물리 수신기의 lease/epoch 강제·로봇 운동 검증은 없음. |
| F37 | edge 배포·rollback·benchmark | 조건부: [고정 모델/컴포넌트·실제 상태 확인][edge] 구현 | 등록 core·Greengrass/component·이미지·장비 필요. Jetson/TensorRT·실제 장치 성능 미검증, import metric은 측정 신원 증거와 구분합니다. |
| F38 | 실험 비교·모델 계보 | 부분: [step 축 비교][compare], [archive provenance][archives], 불변 model/report/video, 미래 SM project/owner identity | [실제 pipeline 정의 업데이트][pipeline-update]는 미래 실행용이며 기존 MLflow run을 재분류하지 않음. [native archive→프로젝트 model 및 출처 계보 실제 PASS][native-proof]. 과거 image tag·unversioned input URI는 byte-pin으로 승격하지 않습니다. |
| F39 | 품질 gate·Registry 반영 | 부분: [품질 정책][promotion]과 [명시적 Registry API][registry] 구현; 정확한 model/gate/package 확인 후 Update/Describe | 애플리케이션 승인과 AWS 반영은 별도. PENDING/ERROR는 성공 아님. 미래 pipeline 기본값 `PendingManualApproval` 실제 적용, **실제 Registry 승인·GR00T 품질 평가 증거 없음**. 기존 Approved 또는 smoke는 대체 증거가 아닙니다. |

## F40–F42: 빌드·비용·자동화

| ID | 기능 | 소스·테스트 상태 | 실제 증거와 남은 조건 |
|---|---|---|---|
| F40 | 소스 빌드·이미지 추적 | 부분 구현: [SourceBuild][source-builds], [격리 CodeBuild][build-project], pinned S3/Git source·buildspec·ECR digest와 UI | [**실제 PASS 46.9초**][source-proof]: S3 VersionId/hash→CodeBuild SUCCEEDED→검사한 ECR digest→profile provenance 연결, 중복 요청 방지·테스트 profile 비활성 확인. 이전 map 순서 비교 409는 수정됐습니다. 기본 smoke는 작은 `FROM scratch` 이미지이며 GPU recipe 빌드가 아닙니다. managed builder image 비고정·전이 의존성 미증명 한도 유지. |
| F41 | 프로젝트/run 비용·안전 축소 | 구현: [사용량][usage], [단가 출처][rates], [계획·정책][scaling], [회귀 테스트][scaling-test]. 요청 CPU/GPU-hour·시간/SKU 포함 추정, 누락은 unknown | **실제 scale 없음; 현재 외부 GPU 1개 보존.** 새 정책 기본값은 관측 수, idle 기본 false. 브라우저 관리자가 명시적 `minCount=0, baselineCount=0`과 노드 계획을 검토하면 모든 검사 통과 시 0까지 가능. 보편적 GPU≥1 제한 없음. provider 최소값·활동/세션/finalization·spec/count/UID·동시성 검사는 유지합니다. |
| F42 | REST/CLI·webhook/MCP | 부분 구현: [token][tokens]·[CLI][cli]·[webhook][webhooks]의 project scope, HMAC·내구 retry/dead letter | [실제 PASS][webhook-proof] `da3408a8e258faee`: 자체 AWS 수신기 HMAC 검증·200/DELIVERED/1회. [fixture·secret 정리 확인][webhook-cleanup]. 외부 사람에게 보낸 알림 없음. 수신기 event-ID 중복 제거 필요; MCP/전체 OSMO API 호환은 미지원입니다. |

## 수치와 지원 경계

| 영역 | 보장 범위 / 한도 |
|---|---|
| 데이터·runtime | 파일 1 TiB, 상대 경로 1,024 bytes; task 전체 1,024파일·64그룹·metadata 2 MiB, URL 64파일/page. checkpoint registration 300,000 bytes·최대 10,000 parts. 구형 broker로 큰 파일을 single PUT downgrade하지 않습니다. scratch/FSx 공간과 timeout은 별도 조건입니다. |
| 불변 데이터 | READY 탐색 200개/page, manifest/파일 VersionId와 hash 고정. include/exclude는 버전 생성 때 적용; 이미 확정된 내용을 바꾸려면 새 버전 필요. tombstone은 bytes purge가 아닙니다. |
| 로그 | captured-only, archive당 64 MiB 또는 65,536 records·30일 보관, catalog 최대 256 streams. UI는 10,000줄/1,048,576문자, cursor 최대 1시간. 잘린 범위와 gap 표시; CLI stdout과 cursor 저장은 원자적이지 않습니다. |
| 모델 archive | configured account/region/pipeline/project의 검증 가능한 완료 producer만. tar 압축/확장 최대 100 GiB·10,000 regular files, report 4 MiB; 외부 manifest는 runtime 1,024 objects/2 MiB 한도 적용. 임의 prefix·모호한 package·cross-execution report·검증 불가 cache는 거부합니다. 명시적 selective reuse의 출처는 보존합니다. |
| SourceBuild | S3 ZIP 32 MiB, 확장 128 MiB/4,096 entries. Git은 전체 commit ID, S3는 VersionId/SHA256. 확인 불가 start는 START_UNCERTAIN; managed builder/transitive dependencies의 byte 동일 재빌드는 보장하지 않습니다. |
| 비용·축소 | 요청 자원의 시간 배분 추정이며 실측 청구서가 아닙니다. 계정 Cost Explorer는 관리자 전용. 30일 초과 단가는 unknown; 최대 1,000개 발견 run. 축소는 관측 가능한 정상 homogeneous On-Demand EKS pool만; Slurm/Spot/reserved/autoscaler/privileged-host는 안전한 idle로 추정하지 않습니다. 외부 console 변경과 AWS capacity API 사이 원자적 If-Match는 없습니다. |
| 조건부 이미지·장비 | Cosmos/LeIsaac 선택 CDK 입력은 구현됐지만 실제 선택 이미지 build/runtime 미검증. 추가 backend·OpenPI/Mimic/SDG·GPU closed-loop·Jetson/물리 HIL은 각 조건과 증거가 더 필요합니다. |

## 아직 확인되지 않은 범위

- 기존 9/14 artifact의 archive→READY dataset→model 등록은 통과했습니다. 새 GR00T 학습·평가·Registry 승인과 GPU closed-loop는 아직 검증되지 않았습니다.
- 로컬 1,178 PASS는 모든 실제 서비스·하드웨어 조합의 성공을 뜻하지 않습니다. 추가 backend·모델·장비 조건은 위 표대로 남아 있습니다.
- 실제 용량 축소나 idle 정책 활성화는 수행하지 않았습니다.

[submission]: ../../dashboard/web/src/server/workflow/submission.ts
[repo]: ../../dashboard/web/src/server/store/repo.ts
[schema]: ../../dashboard/web/src/server/workflow/schema.ts
[validate]: ../../dashboard/web/src/app/api/workflows/validate/route.ts
[templates]: ../../dashboard/web/src/app/api/templates/README.md
[execution]: ../../dashboard/web/src/server/workflow/execution.ts
[groups]: ../../dashboard/web/src/server/workflow/groups.ts
[broker]: ../../dashboard/web/src/server/runtime/broker.ts
[compile]: ../../dashboard/web/src/server/workflow/compile.ts
[runtime]: ../../dashboard/runtime/runtime.go
[multipart-runtime]: ../../dashboard/runtime/MULTIPART.md
[restore]: ../../dashboard/runtime/RESTORE.md
[large-test]: ../../dashboard/web/e2e/runtime-multipart.spec.ts
[large-proof]: evidence/2026-09-16-release4/large-checkpoint-proof.json
[quota-proof]: evidence/2026-09-16-release4/large-quota-attempt.json
[images]: ../../dashboard/web/src/server/services/image-profiles.ts
[topology]: ../../dashboard/web/src/server/workflow/topology/planner.ts
[backends]: ../../dashboard/web/src/server/backends/README.md
[selection]: ../../dashboard/web/src/server/data/selection.ts
[limits]: ../../dashboard/web/src/server/runtime/limits.ts
[input-proof]: evidence/2026-09-16-release4/input-pagination-proof.json
[references]: ../../dashboard/web/src/server/store/dataset-references.ts
[download]: ../../dashboard/web/src/app/api/datasets/[name]/versions/[v]/download/route.ts
[lineage-tests]: ../../dashboard/web/src/server/store/dataset-lineage.test.ts
[browser-multipart]: ../../dashboard/web/src/server/services/multipart-uploads.ts
[credentials]: ../../dashboard/web/src/server/services/credentials.ts
[trusted]: ../../dashboard/web/src/server/services/EXECUTION_PROFILES.md
[logs]: ../../dashboard/web/src/server/logs/archive.ts
[logs-http]: ../../dashboard/web/src/server/logs/http.ts
[logs-test]: ../../dashboard/web/src/components/workflows/LogViewer.browser.test.ts
[log-proof]: evidence/2026-09-16-release4/log-archive-proof.json
[pipelines]: ../../dashboard/web/src/server/services/pipelines.ts
[sessions]: ../../dashboard/web/src/server/services/sessions.ts
[gateway]: ../../dashboard/web/src/server/gateway/README.md
[files]: ../../dashboard/runtime/files_server.go
[cli]: ../../dashboard/cli/README.md
[tokens]: ../../dashboard/web/src/server/auth/api-tokens.ts
[distributed]: ../../dashboard/web/e2e/distributed.spec.ts
[recipes]: ../../dashboard/recipes/README.md
[archives]: ../../dashboard/web/src/server/services/pipeline-archives.ts
[leisaac]: ../../dashboard/recipes/leisaac/evaluate.py
[bundles]: ../../dashboard/web/src/server/evaluations/bundles.ts
[devices]: ../../dashboard/web/src/server/services/devices.ts
[edge]: ../../dashboard/edge/README.md
[compare]: ../../dashboard/web/src/components/pages/experiment-compare.ts
[promotion]: ../../dashboard/web/src/server/evaluations/promotion-policy.ts
[registry]: ../../dashboard/web/src/app/api/models/[id]/registry-approval/route.ts
[pipeline-update]: evidence/2026-09-16-release4/native-pipeline-update.json
[optional-images]: ../../dashboard/infra/lib/constructs/optional-workload-images.ts
[source-builds]: ../../dashboard/web/src/server/services/source-builds.ts
[build-project]: ../../dashboard/infra/lib/constructs/source-build-project.ts
[usage]: ../../dashboard/web/src/server/services/usage.ts
[rates]: ../../dashboard/web/src/server/aws/hyperpod-rates.json
[scaling]: ../../dashboard/web/src/server/services/scaling-plans.ts
[scaling-test]: ../../dashboard/web/src/server/services/scaling-plans.test.ts
[webhooks]: ../../dashboard/web/src/server/services/webhooks.ts
[webhook-proof]: evidence/2026-09-16-release4/webhook-proof.json
[webhook-cleanup]: evidence/2026-09-16-release4/webhook-cleanup-audit.json

[native-proof]: evidence/2026-09-16-release4/historical-pipeline-archive-proof.json
[source-proof]: evidence/2026-09-16-release4/source-build-proof.json
