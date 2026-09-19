# Physical AI Dashboard

데이터 준비, 학습, 평가, 시각화와 운영을 웹에서 연결하는 **Next.js 16.3.5** 기반 연구 환경입니다. **Amazon Cognito + ALB**로 인증·접속하고 프로젝트의 HyperPod EKS, SageMaker, FSx for Lustre, S3 자원을 사용합니다. **OSMO 연구 흐름의 AWS 구현이며, 전체 OSMO 기능·API 호환이나 모든 모델/로봇의 검증 완료를 주장하지 않습니다.**

현재 배포 접속 주소: `https://physical-ai.hi-yoo.com/`

[기능별 구현·제한](../docs/reports/2026-09-16-feature-evidence.md) · [Release 4 실제 검증](../docs/reports/2026-09-16-release4-validation.md) · [승인 설계](../docs/designs/2026-09-16-physical-ai-dashboard.md) · [화면별 기능·AWS 매핑 (스크린샷·다이어그램)](docs/dashboard-features-and-aws-architecture.md)

현재 배포 `6792484`에서 SourceBuild와 token/DCV/로그인/me 검증을 통과했습니다. 이전에 확인한 대용량 checkpoint 복원·65파일 hydration·로그 재생·AWS webhook 수신/정리 증거도 보존합니다. **기존 10.45 GB GR00T artifact의 archive→READY dataset→모델 등록도 실제 통과했습니다.** 새 학습·품질 승인을 의미하지는 않습니다.

## 처음 연구를 시작할 때

1. **연구 프로젝트**를 선택합니다. **워크플로 → 새 실행 → CPU 학습 → 평가 시작**은 `mujoco-pipeline`에 `steps=512`, `num_envs=1`, `episodes=20`을 설정합니다. 작은 시작 설정이며 품질·완료시간 보장은 아닙니다. 실제 기록된 모델 평가 증거는 2 episodes, `REVIEW`, `approved=false`입니다.
2. 데이터가 필요하면 **데이터셋**에서 새 `PENDING` 버전에 여러 번 나누어 업로드합니다. include/exclude는 상대 파일 또는 디렉터리 prefix로 지정합니다. 준비가 끝나면 **검증 및 버전 확정**을 누르고 `READY`를 기다립니다. 확정된 파일을 바꾸려면 새 버전을 만드세요.
3. 레시피의 데이터 버전·변수·이미지 검사 결과를 확인하고 제출합니다. 차단 항목은 해결해야 하며, 검토 경고는 직접 확인합니다. 전문가용 YAML 편집과 불변 템플릿 버전 선택도 유지됩니다.
4. 실행 상세에서 DAG, 시도별 상태·로그·이벤트·지표를 봅니다. 로그는 Pod가 있는 동안 Kubernetes API에서 직접 읽어 표시하며 Pod가 삭제되면 더 볼 수 없습니다. 터미널·파일·Jupyter/code-server/TensorBoard는 **세션**에서 엽니다.
5. 결과가 `READY`이면 고정된 dataset/version/checkpoint를 **모델**에 등록합니다. 검증된 평가 JSON·영상과 명시적 품질 판정을 사용합니다. Smoke, 시뮬레이터 성공률, 물리 로봇 검증은 서로 다른 증거입니다.
6. HF/NGC 등은 **접근 관리**에 credential을 등록하고 값 대신 참조를 선택합니다. 기본은 개인용이며 프로젝트 공유는 명시적입니다. CLI token도 이 화면에서 scope·만료를 정하고 폐기합니다. [CLI 사용법](cli/README.md)을 참고하세요.

**GR00T 전체 파이프라인** 링크는 SageMaker의 프로젝트 실행 화면으로 연결됩니다. 9월 14일 완료된 100-step 학습의 약 10.45 GB artifact가 확인됐지만, 이번 행정적 이력 등록은 새 학습이 아닙니다. 해당 산출물의 전체 checksum·고정 버전을 검증해 READY dataset과 모델로 등록했습니다. 새 GPU 평가나 품질·Registry 승인은 별도입니다.

## 주요 화면

| 화면 | 기능과 범위 |
|---|---|
| 워크플로 | DAG·JobSet/barrier·재시도·checkpoint, 검색·복제·취소, 불변 실행 구성과 템플릿 버전. **Artifacts** 탭은 태스크가 게시한 READY 버전의 파일을 고정 manifest에서 읽어 이미지·영상은 갤러리로 재생하고 JSON·텍스트는 인라인으로, 가중치는 다운로드로 제공합니다(5분 presigned, VersionId 고정). manifest 없는 구버전 출력은 사유만 표시 |
| 데이터셋 | PENDING→검증→READY, manifest/파일 VersionId 고정 탐색·다운로드, 필터·태그·전체 역사적 참조 검사 |
| 모델·파이프라인 | EKS/등록 SageMaker 산출물 계보, 비동기 archive·평가·품질 gate. 기존 GR00T native artifact의 READY 게시·모델 등록 실제 PASS |
| 지표·실험·사용량 | AMP/MLflow, step 축 비교, 프로젝트/run CPU·GPU-hour 통계(비용 추정 없음). 누락은 unknown |
| 세션 | 별도 HTTPS origin의 앱/터미널/파일. 공유 DCV console은 관리자용이며 workload별 노드 전용 DCV는 아님. Isaac Sim DCV 데스크톱은 "여기서 보기"로 대시보드 안 iframe에 표시(gateway가 dcv 세션 응답의 X-Frame-Options를 대시보드 origin만 허용하는 frame-ancestors로 교체) 또는 새 창으로 연다 |
| 실시간 보기 | 태스크 YAML에 `live: true`를 주면 컴파일러가 신뢰 이미지(MUJOCO_IMAGE_URI)의 MJPEG 사이드카(native sidecar, 포트 `pai-live`/8090)를 붙이고 `PAI_LIVE_DIR`을 주입합니다. 레시피가 `$PAI_LIVE_DIR/frame.jpg`를 원자적으로 갱신하면(MuJoCo train/evaluate 기본 적용) 워크플로 상세 "실행 중인 작업 → 실시간 보기 준비"에서 port-forward 세션으로 화면 안에 iframe 재생합니다. 실행 소유자·연구자 권한·RUNNING 태스크에서만 열리고, 세션 만료 시 끊깁니다 |
| 컴퓨트·backend | 기본/allowlist EKS와 준비 상태·차단 사유, 관리자 정책과 검토한 노드 변경 계획. 추가 backend 실제 검증은 없음 |
| 리소스 | 배포 태그(기본 PhysicalAI=true)가 붙은 계정 내 AWS 리소스를 서비스별로 나열하고 EC2는 상태·타입·IP를 함께 표시. 읽기 전용, 60초 캐시 |
| 이미지·실행 환경 | private ECR digest 승인과 별도 관리자 신뢰 실행 profile. 전용 node UID/taint/점유 검사; 실제 privileged node 실행은 미검증 |
| 빌드 | 등록된 S3/Git source·CodeBuild·ECR provenance. S3 source→CodeBuild→ECR digest→profile 연결 실제 PASS. 기본 검증은 작은 FROM scratch 이미지 |
| 엣지·자동화 | 등록 장치 lease·고정 모델/component·rollback/benchmark, REST/CLI·HMAC webhook. 물리 장치 검증과 MCP는 별개 |

## 언어 (한국어 / English)

모든 화면 문구는 `web/src/lib/i18n/messages/`의 타입 검사되는 카탈로그에서 한국어·영어 두 가지로 제공됩니다. 첫 방문은 브라우저 `Accept-Language`로 언어를 고르고, 사이드바 하단의 **한국어 | EN** 토글로 바꾸면 `pai-locale` 쿠키(1년)에 저장되어 새로 고침 없이 즉시 적용됩니다. URL은 언어와 무관하므로 공유 링크·API·게이트웨이 세션 호스트에 영향이 없습니다. 상태 값은 한국어에서 라벨(성공·실행 중 등)로 표시하고 원래 값은 툴팁으로 남깁니다. 서버가 돌려주는 API 오류 문구와 내장 레시피 설명은 아직 단일 언어이며, `Accept-Language` 기반 협상은 후속 작업입니다. 새 문구를 추가할 때는 해당 네임스페이스 모듈의 `en`/`ko`에 함께 넣어야 하며(`ko` 누락은 타입 오류), 컴포넌트에 한글을 직접 쓰면 `no-hardcoded-strings.test.ts`가 실패합니다.

## 비용과 노드 수 변경

**사용량**은 기록된 요청 CPU/GPU 시간을 집계한 CPU-hour / GPU-hour 통계이며 금액을 추정하지 않습니다. 실제 청구서나 GPU 활용률이 아니며 idle 인프라·스토리지·네트워크 등은 제외합니다. **AWS 계정 전체 비용 (최근 30일)**은 관리자에게만 표시하는 Cost Explorer 실제 값이며 대시보드 프로젝트 비용으로 해석하지 않습니다.

**컴퓨트 → 계획·차단 사유**에서 관리자가 정책과 노드 변경 계획을 검토합니다. 정책은 자동 생성되지 않고 새 입력값은 현재 관측 노드 수이며, **유휴 자동 축소는 기본 비활성**입니다. 명시적 `minCount=0`, `baselineCount=0` 저장 후 검토한 계획을 실행하면 모든 검사와 provider 최소값이 허용하는 경우 GPU도 0까지 줄일 수 있습니다. 별도의 추가 승인 단계는 없습니다. 자동 축소를 원할 때만 별도 체크박스로 허용합니다.

실행 전 workflow·session·finalization·Pod 활동과 설정/count·node UID·정책 버전·동시 변경을 재검사합니다. 불명확한 활동/결과는 차단 또는 미확인으로 남깁니다. **이번 검증에서 실제 노드 수를 바꾸거나 idle 정책을 활성화하지 않았으며 기존 GPU 1개를 유지했습니다.**

## 데이터·실행 제한

- Checkpoint 소프트웨어 상한은 **1 TiB/파일**입니다. 실제 검증은 **5 GiB+1 MiB, 81 parts, 재시도 후 전체 SHA256 복원**까지입니다. 필요한 scratch/FSx 공간과 전송 timeout은 별도로 확보해야 합니다.
- 입력은 task 전체 **1,024파일·64그룹·metadata 2 MiB**, URL은 64파일씩 전달합니다. 실제 65파일 hydration을 확인했습니다. include/exclude는 새 버전 선택이며 wildcard/일반 YAML connector는 아닙니다.
- READY 데이터는 불변입니다. 참조된 데이터 삭제는 거부하고 삭제 자체도 tombstone이며 원격 bytes purge가 아닙니다. 이미 없어진 과거 metadata를 재구성하지는 못합니다.
- 로그는 저장하지 않습니다. 워크플로·작업 화면의 로그는 Kubernetes API로 Pod에서 직접 읽으며(요청당 최대 5,000줄, SSE 55초 연결 후 타임스탬프로 재접속) Pod가 삭제되면 더 볼 수 없습니다. 주입된 자격증명은 시도별 불변 Secret을 근거로 서버에서 redaction합니다.
- CLI sync는 파일 단위 전송이며 rsync/block-delta·ranged resume·remote delete가 아닙니다. 일반 private registry, EFS connector, Slurm DAG, 임의 cross-account/region backend, MCP는 지원하지 않습니다.
- Cosmos/LeIsaac 선택 이미지 배선은 있으나 해당 이미지 build·GPU closed-loop는 미검증입니다. OpenPI/Mimic/SDG/Jetson/HIL의 모델·자산·장비 조건은 별도로 충족해야 합니다.

## 설치·개발

웹 API·worker·gateway는 별도 ECS Fargate 서비스와 IAM 역할을 사용합니다. DynamoDB가 실행/시도/소유권/lease/outbox 원장입니다. 컨트롤러는 5초마다 미완료 워크플로우를 lease 아래에서 reconcile하고, 데드라인은 워크플로우 `timeout`(queue/start/exec)과 Kubernetes Job `activeDeadlineSeconds`가 양쪽에서 집행합니다. 작업 데이터는 고정 S3 manifest로 준비하고 FSx 결과는 검증한 S3 버전으로 게시합니다. 일반 연구자 작업은 non-root·제한 경로를 사용하고, host privilege는 [별도 관리자 신뢰 경계](web/src/server/services/EXECUTION_PROFILES.md)입니다.

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

### 모듈 선택

| context | 기본 | 설명 |
|---|---|---|
| `domainName`·`hostedZoneId`·`hostedZoneName` | (없음) | 셋을 모두 주면 HTTPS + ALB Cognito 로그인(호스트 기반 세션 게이트웨이 `<id>.apps.<domain>`). 모두 생략하면 ALB DNS 이름으로 HTTP 접속(HTTP 모드; 세션 게이트웨이는 ALB `:8080` 리스너의 경로 기반 `/s/<id>/…`로 동작) |
| `gateway` | `true` | 세션 게이트웨이(Jupyter·터미널·실시간 보기). HTTPS 배포는 호스트 기반(`<id>.apps.<domain>`), HTTP 배포는 ALB `:8080`의 경로 기반(`/s/<id>/…`)으로 두 ingress 모드 모두에서 동작. `false`면 세션 화면 비활성 |
| `images` | `mujoco,isaaclab,ros2,workspace` | 빌드할 워크로드 이미지. `extendedImages=true`는 `groot,openpi` 추가 |
| `imageOverrides` | `{}` | 이미 있는 ECR 이미지 재사용. 예 `'{"mujoco":"<acct>.dkr.ecr.us-east-1.amazonaws.com/pai/mujoco@sha256:…"}'` 같은 계정·리전 ECR만. |
| `sourceBuild` | `true` | 연구자 소스 이미지 CodeBuild + ECR |
| `edge` | `true` | Greengrass/IoT 권한과 엣지 화면 |
| `waf` / `alarms` | `true` | WAF 웹 ACL / CloudWatch 알람 5개 |
| `resourceTagKey` / `resourceTagValue` | `PhysicalAI` / `true` | 모든 리소스에 붙는 태그. 리소스 화면이 이 태그로 조회 |

**주의 — 이미 배포된 스택에서 모듈을 끄는 것은 파괴적입니다.** `gateway=false`는 gateway 서비스와 `*.apps.<도메인>` 레코드를 삭제하고 ACM 인증서의 SAN이 바뀌어 **인증서가 교체**되며 ALB HTTPS 리스너가 갱신됩니다. `waf=false`·`alarms=false`·`sourceBuild=false`·`edge=false`도 해당 리소스와 IAM 권한을 삭제합니다. 새 계정에서 처음 배포할 때 고르거나, 기존 배포에서는 `cdk diff`로 교체·삭제 대상을 확인한 뒤 적용하세요. `imageOverrides`는 **같은 계정·같은 리전의 ECR** 이미지만 지원합니다(태스크 역할의 `ecr:*` 권한이 해당 범위로 제한됨).

도메인이 없으면 세 도메인 context를 생략합니다. ALB DNS 이름으로 `http://` 접속하며, 로그인은 대시보드의 `/login` 페이지가 Cognito 사용자 풀에 직접 인증합니다(`AUTH_MODE=cognito`). 초기 관리자 계정은 같은 Secrets Manager secret에 있습니다. 이 모드에서는 세션 게이트웨이가 와일드카드 도메인 대신 **같은 ALB의 `:8080` 리스너**를 통해 `http://<alb-dns>:8080/s/<sessionId>/…` 경로로 동작합니다(`GATEWAY_MODE=path`, `GATEWAY_PUBLIC_ORIGIN=http://<alb-dns>:8080`; web·controller·gateway 컨테이너에 주입). `:8080`은 ALB 보안 그룹에서 이미 인바운드로 열려 있으므로(`infra/lib/constructs/ingress.ts`) 세션을 쓰는 사용자가 해당 포트에 도달할 수 있는 네트워크에 있는지 확인하세요. Isaac Sim DCV 데스크톱은 이 모드에서 **새 창 열기만** 지원합니다(대시보드 안 iframe 임베드는 호스트 모드 전용 기능이며, 이 배포 환경에는 실제 HTTP 배포가 없어 아직 실측하지 않았습니다). 앱이 내려주는 `__Secure-` 접두사 쿠키는 브라우저 제약상 평문 HTTP origin에서 저장되지 않으므로 해당 쿠키를 쓰는 업스트림 앱은 이 모드에서 동작하지 않습니다. `USER_PASSWORD_AUTH`를 켠 secret-less 앱 클라이언트는 HTTP·HTTPS 배포 양쪽 모두에 존재하므로, 사용자 풀에 대한 비밀번호 시도는 Cognito 자체의 throttling과 사용자 풀의 비밀번호 정책으로만 제한됩니다. 브라우저와 ALB 사이가 평문이므로 신뢰할 수 있는 네트워크(VPN·사내망)에서만 사용하세요. 경로 모드에서는 모든 세션이 같은 origin을 공유하므로 세션 간 브라우저 저장소 격리가 host 모드보다 약합니다(신뢰 네트워크용).

```bash
cd dashboard/infra && npm ci && npx cdk deploy -c gateway=false
```

같은 태그가 GrootFinetune·IsaacLab·HyperPodEks 스택에도 붙습니다(각 스택을 다시 배포하면 적용).

기본 이미지는 MuJoCo/Isaac Lab/ROS 2/작업 공간, `extendedImages=true`는 GR00T/OpenPI를 추가합니다. 이미 GR00T/OpenPI 이미지가 배포된 스택은 이후 배포에서도 `extendedImages=true`를 유지해야 이미지가 삭제되지 않습니다. `gr00t-e2e` 템플릿(HF 가져오기 → GR00T N1.6.1 파인튜닝 → open-loop 평가)은 두 이미지(MUJOCO_IMAGE_URI, GROOT_RUNTIME_IMAGE_URI)와 프로젝트 GPU 큐가 필요하며, 모델 등록은 게시된 평가 결과를 모델·평가 화면에서 진행합니다. Cosmos/LeIsaac은 [optionalImages 계약](infra/lib/constructs/optional-workload-images.ts)에 맞는 digest 고정 이미지·scene 입력이 필요하며 옵션을 생략하면 생성하지 않습니다. 이미지 배포는 모델 접근·실행 품질 승인이 아닙니다.

기존 웹 내부 controller를 분리하는 **첫 전환에만** `-c controllerSplitMigration=true`를 사용하고 이후 제거합니다. EKS add-on/RBAC는 `infra/ops/apply_addons.py` 또는 등록된 관리자 운영 작업으로 준비합니다. 초기 관리자 secret은 `physical-ai-dashboard/<accountId>/admin`에 저장됩니다. 부모 HyperPod/Isaac Lab 스택과 상태 리소스 보존을 확인하고 대시보드 업데이트 범위를 유지하세요.

```bash
cd dashboard/web
npm ci
npm test
npm run typecheck
npm run build
npm run build:services
```

로컬에서 띄워 보려면 `npm run dev:local`(= `web/scripts/dev-local.sh`)을 사용합니다. 기본 **aws 모드**는 배포된 ECS web 태스크 정의에서 환경 변수를 읽어 `web/.env.aws.local`(gitignore)에 캐시하고, 로컬 AWS 자격증명으로 실제 DynamoDB·S3·SageMaker 데이터를 보여 줍니다. `AUTH_MODE=dev`로 모든 요청이 admin(`--role`/`--user`로 변경)이 되고 `WORKFLOW_CONTROLLER=0`을 강제해 ECS 컨트롤러와 경쟁하지 않습니다. 단 실행·데이터셋 생성은 실제 테이블에 기록됩니다. `--offline`은 AWS 호출 없이 인메모리 저장소로 UI만 확인하고, `--refresh`는 env 캐시를 다시 받으며, `--port`로 포트를 바꿉니다. `AUTH_MODE=dev npm run dev`는 로컬 전용입니다. 실제 AWS 테스트에는 Cognito 자격증명을 테스트 프로세스에만 주입하며 로그에 남기지 않습니다. 테스트는 실제 작업/세션을 만들 수 있으므로 [연구자 E2E 조건](web/e2e/README.researcher.md)과 해당 fixture 범위를 먼저 확인하세요.

개발 자료: [workflow](web/src/server/workflow/README.md), [runtime](runtime/README.md), [multipart](runtime/MULTIPART.md), [복원](runtime/RESTORE.md), [레시피](recipes/README.md), [gateway](web/src/server/gateway/README.md), [CLI](cli/README.md), [edge](edge/README.md).
