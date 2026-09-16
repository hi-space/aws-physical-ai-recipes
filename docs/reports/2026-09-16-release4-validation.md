# Release 4 검증 결과 — 2026-09-16

**배포 후 SourceBuild·token/DCV·로그인/me 검증이 통과했습니다. 대용량 checkpoint 복원·65파일 입력·로그 재생·AWS webhook 증거도 확인했습니다. 기존 10.45 GB GR00T 산출물의 native archive→READY dataset→모델 등록도 실제 통과했습니다.**

소스 구현, 로컬 테스트와 실제 AWS 실행을 구분합니다. F01–F42 전체 완료·OSMO API 호환·새 GR00T 학습 성공을 의미하지 않습니다.

현재 배포 접속 주소: `https://physical-ai.hi-yoo.com/`

[기능별 상태](2026-09-16-feature-evidence.md) · [사용 가이드](../../dashboard/README.md) · [이전 실제 검증](2026-09-16-release3-validation.md) · [보관 증거·SHA256 목록](evidence/2026-09-16-release4/hotfix-evidence-index.json)

## 배포와 소스

| 항목 | 확인 결과 |
|---|---|
| 환경 | 계정 `913524902871`, `us-east-1`, 프로젝트 `workshop`, 기본 EKS backend |
| 현재 소스 | `6792484`; [배포용 소스 543파일 hash](evidence/2026-09-16-release4/hotfix-source-freeze.json)와 일치 |
| 기존 작업 보존 | 원본 저장소도 `6792484`로 fast-forward 완료. [보존 audit](evidence/2026-09-16-release4/final-original-preservation.json)에서 기존 워크숍 수정 5개 파일의 hash가 모두 유지됐음을 확인 |
| 현재 이미지 | `sha256:8f117e39436c3a91193785f5ad5b6efc91284d9610c31fb7e3474f41cd55caf7` |
| 배포 상태 | [배포 확인](evidence/2026-09-16-release4/hotfix-deployment-proof.json): CloudFormation `UPDATE_COMPLETE`; Web20/Controller10/Gateway10 각각 1개 실행·HEALTHY |
| 변경 범위 | SourceBuild/native archive의 DynamoDB map 순서 비교 수정. 세 서비스 이미지 참조만 교체; 모델/runtime/workspace asset hash 유지 |
| 이전 검증 기준 | `9ce955750f6c3325952d7fef8ffd0d419e032767`, digest `sha256:6df20e05a616e1052d06a16d365adb41eef9e482c3f0769ce2a3965bb03566fa`. 대용량 checkpoint·입력 paging·로그 재생은 이 배포에서 확인 |

## 소스 테스트

| 범위 | 결과 | 검증 범위 |
|---|---|---|
| 기준 Release 4 full web | [**1,150 PASS / 2 opt-in SKIP**](evidence/2026-09-16-release4/release4-unit-tests.log) | web/E2E/infra 타입 검사, Next/services build, infra 6 tests PASS |
| 현재 수정본 full web | [**1,178 PASS / 2 opt-in SKIP**](evidence/2026-09-16-release4/hotfix-unit-tests.log) | focused 92, infra 6, 모든 타입 검사·Next/services build PASS |
| Runtime 별도 검증 | **83 TypeScript runtime tests PASS**, 실제 static Go binary↔Node broker 로컬 왕복, Go race suite/vet PASS | amd64/arm64 static ELF build 확인. AWS 1 TiB 전송 증거는 아님 |
| F41 zero-policy | **46 tests PASS**, whole-web typecheck PASS | explicit 0/0·전체 mock 노드 계획·0→1 재시작, 활동/정책 변경 차단, idle 별도 opt-in. 실제 capacity RPC 없음 |
| 순서 비교 회귀 | SourceBuild **40**, native archive **52** focused tests PASS | map 순서는 무시하되 실제 identity 변경은 거부. 위 full suite와 중복 합산하지 않음 |

[로컬 검증 요약](evidence/2026-09-16-release4/local-validation.json)은 소스 테스트 결과이며 실제 AWS 검증과 별도입니다. 두 opt-in skip은 Torch recipe 로컬 실행과 static Go broker roundtrip의 별도 실행 조건입니다. Go roundtrip은 별도 검증에서 실제 수행했습니다. 로컬 테스트 통과는 모든 GPU·하드웨어·외부 서비스 조합의 실제 성공을 뜻하지 않습니다.

## 실제 AWS 검증

| 경로 | 결과 | 증거와 한계 |
|---|---|---|
| SourceBuild | **PASS 46.9초**, `sb-65b0c0beacf027069361db0132332186` | [SourceBuild 증거](evidence/2026-09-16-release4/source-build-proof.json): 고정 S3 snapshot→실제 CodeBuild SUCCEEDED→ECR digest 검사→image-profile provenance 연결. 중복 요청 방지, slot 해제·테스트 profile 비활성 확인. 작은 FROM scratch 검증 이미지이며 GPU 모델 build/runtime 증거는 아님 |
| 기존 GR00T archive·모델 등록 | **PASS 27.2분**, `b0a91809624375325e512ff19809a901` | [Archive·모델 증거](evidence/2026-09-16-release4/historical-pipeline-archive-proof.json): 원본/사본 전체 SHA256 일치, 고정 객체·manifest VersionId, dataset v1 READY, 31파일 directory bundle, 모델 `mdl-1748273716578bb4e575c413` 등록. 새 학습·평가·Registry 승인 없음 |
| 배포 후 smoke | **4 PASS, 전체 약 1.3분** | [최종 4개 결과](evidence/2026-09-16-release4/hotfix-smoke-results.json): [token 권한·폐기](evidence/2026-09-16-release4/token-authorization.json) 3.0초, [실제 HTTPS DCV](evidence/2026-09-16-release4/dcv-connection.json) 16.6초, 로그인·모든 페이지 46.8초, `/me` 4.0초. 모든 화면의 모든 기능 검증은 아님 |
| 대용량 checkpoint 복원 | **PASS**, `4b52f39c9f1a25f5`, 약 8.2분 | [증거](evidence/2026-09-16-release4/large-checkpoint-proof.json): **5 GiB+1 MiB = 5,369,757,696 bytes, 81 parts**, 시도1→RESCHEDULE→시도2 전체 크기/SHA256 일치 후 proof 게시. 1 TiB는 소프트웨어 상한 |
| 65파일 입력 paging | **PASS**, `e3883cd7bf426769`, 약 1.6분 | [증거](evidence/2026-09-16-release4/input-pagination-proof.json): 65파일·합계 2145, dataset v1/manifest hash 고정. URL 64파일/page 경계를 넘는 실제 hydration |
| 로그 SSE·archive 재생 | **PASS**, `663accac8b444e5a`, 약 2.2분 | [증거](evidence/2026-09-16-release4/log-archive-proof.json): SSE 2회 연결, 실제 Pod UID, secret redaction, 중복/빈 줄/일반 URL 보존, Pod 삭제 후 재생. 수집된 byte만 보장 |
| 자체 AWS webhook 수신 | **PASS**, `da3408a8e258faee` | [receipt](evidence/2026-09-16-release4/webhook-proof.json), [실행 로그](evidence/2026-09-16-release4/webhook.log): HMAC·event/run/project 일치, DELIVERED/HTTP200/1회. Release 3 배포에서 수행한 증거 보존 |
| Webhook 정리 | **PASS** | [audit](evidence/2026-09-16-release4/webhook-cleanup-audit.json): 자체 Lambda 2개·role·log group 제거, private key 제거, hook 비활성·SSM secret 부재. 외부 사람/기관 수신기는 사용하지 않음 |

[핵심 검증 2개](evidence/2026-09-16-release4/hotfix-core-results.json)는 전체 약 27.4분에 통과했습니다. SourceBuild의 실제 CodeBuild ID는 `physical-ai-source-workshop-913524902871:6c03f42e-fc97-4cf0-a897-5d0cb3f882eb`, 결과 digest는 `sha256:1c31a1f298ef64190d287c13357ab8fdfa3fb3023687da3dbe8e00866cbf2f67`입니다. 입력 ZIP은 439 bytes이며 VersionId와 전체 SHA256을 기록했습니다. `builderImagePinned=false`, `dependencyResolution=not-attested`, `runtimeValidation=not-performed`로 전체 의존성 재현성·런타임 검증과 구분합니다.

## 기존 GR00T artifact와 native archive

**9월 14일 성공 execution `olsvzf6o2fuv`는 `ml4xq8v9ahl6`의 완료된 GR00TFinetune job을 선택적으로 재사용했습니다. 이번에 새 학습을 시작한 것이 아닙니다.** 원본 execution 전체는 Stopped여도 재사용된 개별 training job은 Completed입니다.

| 항목 | 확인 내용 |
|---|---|
| 기존 job | `pipelines-ml4xq8v9ahl6-GR00TFinetune-NAjhza3LoQ`, `ml.g5.12xlarge`, max_steps=100, global_batch_size=4 |
| 실제 최종 metrics | [9/14 job·객체 기록](evidence/2026-09-16-release4/historical-native-metrics.json): `train:loss` 약 **1.0733**, `train:grad_norm` 약 **0.9947**, `train:learning_rate` 약 **2.7337e-8**; 2026-09-14 19:54:31 UTC |
| 원본 model.tar.gz | **10,445,217,162 bytes**(약 10.45 GB), VersionId `f_5ylYJL8Kai3WcAol2XMTw0iB995Rfa` |
| 프로젝트 이력 | [행정적 import](evidence/2026-09-16-release4/historical-pipeline-import.json): `ownershipSource=administrator-import`, native execution 시작/metadata 변경 false, 출처 execution 보존 |
| Archive 결과 | `b0a91809624375325e512ff19809a901` **READY**, dataset `sm-output-b0a91809624375325e512ff19809a901` v1, 모델 `mdl-1748273716578bb4e575c413` 등록 |
| 무결성 | 원본/사본 full SHA256 `73adc13454d50a67b750f0c94600da1ce7377bcc37b2bab12c8b436ded7ee4d5` 일치, destination VersionId `SdW_EQ5KfJLZ6TS4JbiCfZ3QdIdSzwpO`, manifest VersionId `FkJzgm3YNeqnT0eMO9YoKB0D_DkmnjNX` 고정 |
| Bundle | `pai-directory-sha256-v1`, 31파일의 검증된 directory digest와 별도 `model/bundle.json` 버전 보존 |

전체 복사 뒤 고정 객체 버전을 다시 스트리밍해 SHA256을 검증하고 dataset READY·model 등록을 완료했습니다. S3 COMPOSITE checksum과 전체 파일 SHA256을 별도 보존합니다. `SmokeEval`의 예상 model.tar.gz는 404였으므로 `reportSteps=[]`로 archive하며, smoke job 성공에서 평가 report나 품질 승인을 추정하지 않습니다.

[미래 pipeline 정의 변경](evidence/2026-09-16-release4/native-pipeline-update.json)은 `DashboardProjectId`, `DashboardOwnerSubject`, training PAI identity/MLflow namespace, 기본 `PendingManualApproval`을 반영했습니다. **나머지 정의 보존·실행 시작 0회**이며 과거 run을 retag하거나 실제 Registry 승인을 하지 않았습니다.

## 이전 실패와 정정

- 대용량 첫 시도 `bf4fa76442c8e256`은 기존 queue의 ephemeral-storage quota 미지원으로 실행 전에 취소됐습니다. [기록](evidence/2026-09-16-release4/large-quota-attempt.json)을 보존하며 queue는 바꾸지 않았습니다. 재시험에서 불필요한 quota 요청을 제거하고 실제 디스크 여유 검사를 유지했습니다.
- SourceBuild의 configuration changed 409와 native archive의 provenance changed 오류는 DynamoDB map key 순서 비교 문제였습니다. 값을 구조적으로 비교하도록 수정했고 SourceBuild 실제 성공을 확인했습니다. Native archive도 명시적 retry 후 READY와 model 등록을 확인했으며 첫 실패/취소 이력은 보존합니다.
- 최근 새 GR00T 시도 3회는 여전히 **실패/중단**입니다: 작은 G5 optimizer CUDA OOM(`n4r1xdb896rc`), g5.12 용량 대기 후 중단(`w9r84qbsl8xn`), g6e.2 용량 대기 후 중단(`r4ib9i57o09e`). 기존 artifact 재사용이 이를 새 학습 성공으로 바꾸지 않습니다.

## 운영과 지원 한계

- **데이터·checkpoint:** 1 TiB/파일, task 전체 1,024파일·64그룹·metadata 2 MiB, URL 64파일/page. READY는 불변이고 삭제는 tombstone입니다. 전체 역사적 참조 검사는 이미 삭제된 metadata를 복원하지 못합니다. tar 내부 100 GiB/10,000파일 검사 한도와 바깥 dataset/runtime 한도는 별개입니다.
- **신뢰 실행 profile:** 현재 브라우저 플랫폼 관리자·exact task/image·node UID/전용 taint/점유·revocation 검사는 구현/테스트됐습니다. 실제 privileged node/job은 미검증입니다. host 권한은 sandbox가 아니며 hostNetwork HTTP/files와 token trusted exec는 거부합니다.
- **로그:** captured-only, archive당 64 MiB/65,536 records·30일, cursor 최대 1시간. 관측 전 rotation·재접속 gap까지 무손실이라고 하지 않습니다.
- **모델·품질:** tar/bundle digest bridge와 SageMaker archive/Registry adapter는 구현됐습니다. GPU closed-loop·실제 Registry 반영·새 GR00T 품질 증거는 없습니다. 과거 unversioned input/tag는 byte-pin으로 표현하지 않습니다. 기존 MuJoCo 평가는 **2 episodes/REVIEW/approved=false**입니다.
- **선택 이미지·장비:** Cosmos/LeIsaac CDK 배선은 있지만 해당 이미지 build/runtime는 미검증입니다. 추가 backend·OpenPI/Mimic/SDG·LeIsaac/GPU closed-loop·물리 Jetson/HIL·EFA/NCCL/operator 경로는 각 조건과 실제 증거가 더 필요합니다.
- **비용·축소:** requested CPU/GPU-hour·시간이 있는 공식 단가 추정이며 실제 청구서가 아닙니다. 새 정책 기본값은 관측 수, idle 기본 false. explicit admin `minCount=0, baselineCount=0`과 검토한 계획은 spec/count/UID/activity/lease/provider 최소값 검사 통과 시 GPU 0을 허용합니다. **이번 검증에서는 정책 seed·idle 활성화·실제 scaling 없이 CPU2/GPU1을 유지했습니다.**
- **자동화:** 자체 HMAC 수신기를 검증했고 fixture를 정리했습니다. at-least-once 수신기의 event-ID 중복 제거는 필요하며 MCP/전체 OSMO API 호환은 미지원입니다.

[최종 자원 audit](evidence/2026-09-16-release4/hotfix-resource-audit.json)에서 CPU2/GPU1, 세 노드 Ready, active dashboard workload Pod 없음, 기존 terminal Pod 35개 보존, DCV instance Running을 확인했습니다. [소유 자원 정리](evidence/2026-09-16-release4/hotfix-owned-cleanup.json)는 테스트용 SourceBuild profile 비활성과 DCV session 종료·폐기를, [DCV 최종 검사](evidence/2026-09-16-release4/hotfix-dcv-final-audit.json)는 console 연결 0개를 확인합니다. [Archive 최종 audit](evidence/2026-09-16-release4/hotfix-archive-final-audit.json)는 READY dataset·model 영속 기록, active lease 없음, source slot 0개, 소유 archive prefix의 미완료 multipart 0개, 품질 gate 0개와 완료 데이터 보존을 확인합니다.

기존 GPU Isaac·ROS·Gloo의 실제 성공 범위는 [이전 검증 기록](2026-09-16-release3-validation.md)대로 유지합니다.
