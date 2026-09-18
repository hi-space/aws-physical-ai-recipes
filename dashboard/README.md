# Physical AI Dashboard

데이터 준비, 학습, 평가, 시각화와 운영을 웹에서 연결하는 **Next.js 16.3.5** 기반 연구 환경입니다. **Amazon Cognito + ALB**로 인증·접속하고 프로젝트의 HyperPod EKS, SageMaker, FSx for Lustre, S3 자원을 사용합니다. **OSMO 연구 흐름의 AWS 구현이며, 전체 OSMO 기능·API 호환이나 모든 모델/로봇의 검증 완료를 주장하지 않습니다.**

현재 배포 접속 주소: `https://physical-ai.hi-yoo.com/`

[기능별 구현·제한](../docs/reports/2026-09-16-feature-evidence.md) · [Release 4 실제 검증](../docs/reports/2026-09-16-release4-validation.md) · [승인 설계](../docs/designs/2026-09-16-physical-ai-dashboard.md)

현재 배포 `6792484`에서 SourceBuild와 token/DCV/로그인/me 검증을 통과했습니다. 이전에 확인한 대용량 checkpoint 복원·65파일 hydration·로그 재생·AWS webhook 수신/정리 증거도 보존합니다. **기존 10.45 GB GR00T artifact의 archive→READY dataset→모델 등록도 실제 통과했습니다.** 새 학습·품질 승인을 의미하지는 않습니다.

## 처음 연구를 시작할 때

1. **연구 프로젝트**를 선택합니다. **워크플로 → 새 실행 → CPU 학습 → 평가 시작**은 `mujoco-pipeline`에 `steps=512`, `num_envs=1`, `episodes=20`을 설정합니다. 작은 시작 설정이며 품질·완료시간 보장은 아닙니다. 실제 기록된 모델 평가 증거는 2 episodes, `REVIEW`, `approved=false`입니다.
2. 데이터가 필요하면 **데이터셋**에서 새 `PENDING` 버전에 여러 번 나누어 업로드합니다. include/exclude는 상대 파일 또는 디렉터리 prefix로 지정합니다. 준비가 끝나면 **검증 및 버전 확정**을 누르고 `READY`를 기다립니다. 확정된 파일을 바꾸려면 새 버전을 만드세요.
3. 레시피의 데이터 버전·변수·이미지 검사 결과를 확인하고 제출합니다. 차단 항목은 해결해야 하며, 검토 경고는 직접 확인합니다. 전문가용 YAML 편집과 불변 템플릿 버전 선택도 유지됩니다.
4. 실행 상세에서 DAG, 시도별 상태·로그·이벤트·지표를 봅니다. 로그는 수집된 기록을 재생하며, 수집하지 못한 구간은 gap으로 표시합니다. 터미널·파일·Jupyter/code-server/TensorBoard는 **세션**에서 엽니다.
5. 결과가 `READY`이면 고정된 dataset/version/checkpoint를 **모델**에 등록합니다. 검증된 평가 JSON·영상과 명시적 품질 판정을 사용합니다. Smoke, 시뮬레이터 성공률, 물리 로봇 검증은 서로 다른 증거입니다.
6. HF/NGC 등은 **접근 관리**에 credential을 등록하고 값 대신 참조를 선택합니다. 기본은 개인용이며 프로젝트 공유는 명시적입니다. CLI token도 이 화면에서 scope·만료를 정하고 폐기합니다. [CLI 사용법](cli/README.md)을 참고하세요.

**GR00T 전체 파이프라인** 링크는 SageMaker의 프로젝트 실행 화면으로 연결됩니다. 9월 14일 완료된 100-step 학습의 약 10.45 GB artifact가 확인됐지만, 이번 행정적 이력 등록은 새 학습이 아닙니다. 해당 산출물의 전체 checksum·고정 버전을 검증해 READY dataset과 모델로 등록했습니다. 새 GPU 평가나 품질·Registry 승인은 별도입니다.

## 주요 화면

| 화면 | 기능과 범위 |
|---|---|
| 워크플로 | DAG·JobSet/barrier·재시도·checkpoint, 검색·복제·취소, 불변 실행 구성과 템플릿 버전. **Artifacts** 탭은 태스크가 게시한 READY 버전의 파일을 고정 manifest에서 읽어 이미지·영상은 갤러리로 재생하고 JSON·텍스트는 인라인으로, 가중치는 다운로드로 제공합니다(5분 presigned, VersionId 고정). manifest 없는 구버전 출력은 사유만 표시 |
| 데이터셋 | PENDING→검증→READY, manifest/파일 VersionId 고정 탐색·다운로드, 필터·태그·전체 역사적 참조 검사 |
| 모델·파이프라인 | EKS/등록 SageMaker 산출물 계보, 비동기 archive·평가·품질 gate. 기존 GR00T native artifact의 READY 게시·모델 등록 실제 PASS |
| 지표·실험·사용량 | AMP/MLflow, step 축 비교, 프로젝트/run CPU·GPU-hour 및 출처·시각이 있는 비용 추정. 누락은 unknown |
| 세션 | 별도 HTTPS origin의 앱/터미널/파일. 공유 DCV console은 관리자용이며 workload별 노드 전용 DCV는 아님. Isaac Sim DCV 데스크톱은 "여기서 보기"로 대시보드 안 iframe에 표시(gateway가 dcv 세션 응답의 X-Frame-Options를 대시보드 origin만 허용하는 frame-ancestors로 교체) 또는 새 창으로 연다 |
| 실시간 보기 | 태스크 YAML에 `live: true`를 주면 컴파일러가 신뢰 이미지(MUJOCO_IMAGE_URI)의 MJPEG 사이드카(native sidecar, 포트 `pai-live`/8090)를 붙이고 `PAI_LIVE_DIR`을 주입합니다. 레시피가 `$PAI_LIVE_DIR/frame.jpg`를 원자적으로 갱신하면(MuJoCo train/evaluate 기본 적용) 워크플로 상세 "실행 중인 작업 → 실시간 보기 준비"에서 port-forward 세션으로 화면 안에 iframe 재생합니다. 실행 소유자·연구자 권한·RUNNING 태스크에서만 열리고, 세션 만료 시 끊깁니다 |
| 컴퓨트·backend | 기본/allowlist EKS와 준비 상태·차단 사유, 관리자 정책과 검토한 노드 변경 계획. 추가 backend 실제 검증은 없음 |
| 이미지·실행 환경 | private ECR digest 승인과 별도 관리자 신뢰 실행 profile. 전용 node UID/taint/점유 검사; 실제 privileged node 실행은 미검증 |
| 빌드 | 등록된 S3/Git source·CodeBuild·ECR provenance. S3 source→CodeBuild→ECR digest→profile 연결 실제 PASS. 기본 검증은 작은 FROM scratch 이미지 |
| 엣지·자동화 | 등록 장치 lease·고정 모델/component·rollback/benchmark, REST/CLI·HMAC webhook. 물리 장치 검증과 MCP는 별개 |

## 비용과 노드 수 변경

**사용량**의 금액은 기록된 요청 CPU/GPU 시간에 공식 단가를 배분한 추정입니다. 실제 청구서나 GPU 활용률이 아니며 idle 인프라·스토리지·네트워크 등은 제외합니다. 단가 출처·시각·알 수 없는 항목을 확인하세요. **AWS 계정 전체 비용 (최근 30일)**은 관리자에게만 표시하며 대시보드 프로젝트 비용으로 해석하지 않습니다.

**컴퓨트 → 계획·차단 사유**에서 관리자가 정책과 노드 변경 계획을 검토합니다. 정책은 자동 생성되지 않고 새 입력값은 현재 관측 노드 수이며, **유휴 자동 축소는 기본 비활성**입니다. 명시적 `minCount=0`, `baselineCount=0` 저장 후 검토한 계획을 실행하면 모든 검사와 provider 최소값이 허용하는 경우 GPU도 0까지 줄일 수 있습니다. 별도의 추가 승인 단계는 없습니다. 자동 축소를 원할 때만 별도 체크박스로 허용합니다.

실행 전 workflow·session·finalization·Pod 활동과 설정/count·node UID·정책 버전·동시 변경을 재검사합니다. 불명확한 활동/결과는 차단 또는 미확인으로 남깁니다. **이번 검증에서 실제 노드 수를 바꾸거나 idle 정책을 활성화하지 않았으며 기존 GPU 1개를 유지했습니다.**

## 데이터·실행 제한

- Checkpoint 소프트웨어 상한은 **1 TiB/파일**입니다. 실제 검증은 **5 GiB+1 MiB, 81 parts, 재시도 후 전체 SHA256 복원**까지입니다. 필요한 scratch/FSx 공간과 전송 timeout은 별도로 확보해야 합니다.
- 입력은 task 전체 **1,024파일·64그룹·metadata 2 MiB**, URL은 64파일씩 전달합니다. 실제 65파일 hydration을 확인했습니다. include/exclude는 새 버전 선택이며 wildcard/일반 YAML connector는 아닙니다.
- READY 데이터는 불변입니다. 참조된 데이터 삭제는 거부하고 삭제 자체도 tombstone이며 원격 bytes purge가 아닙니다. 이미 없어진 과거 metadata를 재구성하지는 못합니다.
- 로그는 **captured-only**, archive당 64 MiB/65,536 records·30일, UI 10,000줄/1,048,576문자입니다. Pod 삭제 후 재생은 검증했지만 전체 프로세스 출력의 무손실 보장은 아닙니다.
- CLI sync는 파일 단위 전송이며 rsync/block-delta·ranged resume·remote delete가 아닙니다. 일반 private registry, EFS connector, Slurm DAG, 임의 cross-account/region backend, MCP는 지원하지 않습니다.
- Cosmos/LeIsaac 선택 이미지 배선은 있으나 해당 이미지 build·GPU closed-loop는 미검증입니다. OpenPI/Mimic/SDG/Jetson/HIL의 모델·자산·장비 조건은 별도로 충족해야 합니다.

## 설치·개발

웹 API·worker·gateway는 별도 ECS Fargate 서비스와 IAM 역할을 사용합니다. DynamoDB가 실행/시도/소유권/lease 원장이며 Step Functions·SQS가 수명과 복구를 연결합니다. 작업 데이터는 고정 S3 manifest로 준비하고 FSx 결과는 검증한 S3 버전으로 게시합니다. 일반 연구자 작업은 non-root·제한 경로를 사용하고, host privilege는 [별도 관리자 신뢰 경계](web/src/server/services/EXECUTION_PROFILES.md)입니다.

설치에는 기존 HyperPod EKS, private subnet, 관리 가능한 Route 53 zone, Docker/Node.js 22/CDK bootstrap과 배포 권한이 필요합니다. 예시:

```bash
cd dashboard/infra
npm ci
npx cdk deploy \
  -c domainName=physical-ai.example.com \
  -c hostedZoneId=Z0123456789ABC \
  -c hostedZoneName=example.com \
  -c extendedImages=true
```

기본 이미지는 MuJoCo/Isaac Lab/ROS 2/작업 공간, `extendedImages=true`는 GR00T/OpenPI를 추가합니다. 이미 GR00T/OpenPI 이미지가 배포된 스택은 이후 배포에서도 `extendedImages=true`를 유지해야 이미지가 삭제되지 않습니다. `gr00t-e2e` 템플릿(HF 가져오기 → GR00T N1.6.1 파인튜닝 → open-loop 평가)은 두 이미지(MUJOCO_IMAGE_URI, GROOT_RUNTIME_IMAGE_URI)와 프로젝트 GPU 큐가 필요하며, 모델 등록은 게시된 평가 결과를 모델·평가 화면에서 진행합니다. Cosmos/LeIsaac은 [optionalImages 계약](infra/lib/constructs/optional-workload-images.ts)에 맞는 digest 고정 이미지·scene 입력이 필요하며 옵션을 생략하면 생성하지 않습니다. 이미지 배포는 모델 접근·실행 품질 승인이 아닙니다.

Terraform으로 배포하려면 `dashboard/terraform/`을 사용합니다(`terraform/README.md`). 같은 리소스를 만들고 도메인·Cognito 도메인·세션 호스트 도메인은 모두 변수에서 파생되며, `name_prefix`로 기존 CDK 스택과 나란히 두 번째 환경을 띄울 수 있습니다. 컨테이너가 요구하는 환경 변수 계약은 `terraform output environment_contract`와 README의 표에 있습니다.

기존 웹 내부 controller를 분리하는 **첫 전환에만** `-c controllerSplitMigration=true`를 사용하고 이후 제거합니다. EKS add-on/RBAC는 `infra/ops/apply_addons.py` 또는 등록된 관리자 운영 작업으로 준비합니다. 초기 관리자 secret은 `physical-ai-dashboard/<accountId>/admin`에 저장됩니다. 부모 HyperPod/Isaac Lab 스택과 상태 리소스 보존을 확인하고 대시보드 업데이트 범위를 유지하세요.

```bash
cd dashboard/web
npm ci
npm test
npm run typecheck
npm run build
npm run build:services
```

`AUTH_MODE=dev npm run dev`는 로컬 전용입니다. 실제 AWS 테스트에는 Cognito 자격증명을 테스트 프로세스에만 주입하며 로그에 남기지 않습니다. 테스트는 실제 작업/세션을 만들 수 있으므로 [연구자 E2E 조건](web/e2e/README.researcher.md)과 해당 fixture 범위를 먼저 확인하세요.

개발 자료: [workflow](web/src/server/workflow/README.md), [runtime](runtime/README.md), [multipart](runtime/MULTIPART.md), [복원](runtime/RESTORE.md), [레시피](recipes/README.md), [gateway](web/src/server/gateway/README.md), [CLI](cli/README.md), [edge](edge/README.md).
