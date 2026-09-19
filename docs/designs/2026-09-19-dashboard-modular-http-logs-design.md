# Physical AI Dashboard — 모듈화 · 도메인 없는 HTTP 모드 · 로그 아카이브 제거 설계

작성 2026-09-19. 브랜치 `feat/hyperpod-dashboard`, 기준 커밋 `47c776f`. 이 문서는 2026-09-18 아키텍처 단순화(Step Functions·SQS 제거, 커밋 `1f3f9c0`) 이후의 다음 단계다.

## 1. 배경과 문제

2026-09-19 코드 검토에서 확인한 사실:

| 영역 | 현재 | 문제 |
|---|---|---|
| 배포 전제 | `domainName`·`hostedZoneId` 없으면 synth 실패. ALB `authenticate-cognito`는 HTTPS 리스너에서만 동작 | 도메인이 없는 계정·워크숍에서 배포 불가 |
| 스택 구성 | 단일 CDK 스택이 Fargate 3서비스, ALB/WAF/Cognito, 이미지 빌드 6+개, CodeBuild, 엣지 IAM을 무조건 생성 | 필요한 모듈만 고를 수 없음. 이미지 재빌드마다 프로필 재승인 |
| 로그 | controller가 kubelet 스트림을 16 KiB 청크로 잘라 DynamoDB에 TransactWrite(3 아이템)로 저장. 뷰어는 1초마다 Query + 레코드별 GetItem + 커서 PutItem | 64 MiB 아카이브당 약 20만 WCU. CloudWatch Logs 수집 대비 바이트당 약 8배. 열어 둔 뷰어 수에 비례해 읽기 증가 |
| 비용 화면 | `/api/cost`가 캐시 없이 60초 폴링, Cost Explorer 요청당 $0.01 | 관리자 탭 하나당 하루 약 $14 |
| 리소스 가시성 | EC2는 DCV 인스턴스 1대만 표시. 태그 기반 조회 없음 | 프로젝트가 만든 AWS 리소스를 한 화면에서 볼 수 없음 |
| 문서 | 기능 문서·다이어그램이 Step Functions/SQS/callbacks 테이블을 "현재 배포"로 기술 | 코드와 불일치 |

## 2. 결정 요약

| # | 결정 | 근거 |
|---|---|---|
| D1 | 도메인 없는 모드는 **HTTP :80 + 앱 내 Cognito 로그인**(`AUTH_MODE=cognito`) | ALB Cognito는 HTTPS 전용. 사용자·그룹·역할 모델은 그대로 유지 |
| D2 | 세션 게이트웨이는 **경로 기반**(`/s/<sessionId>/…`)으로 전환하고, **전용 ALB 리스너 포트**로 대시보드와 origin을 분리 | 도메인 없이는 와일드카드 호스트 불가. 같은 origin이면 세션 앱 XSS가 대시보드 세션에 닿음 |
| D3 | DynamoDB 로그 아카이브를 **삭제**하고 kubelet 실시간 읽기만 제공 | 매 실행 후 DDB 쓰기 0. Pod 삭제 후 이력은 포기(명시적으로 안내) |
| D4 | 프로젝트 권한 검사와 비밀값 redaction은 **유지** | 연구자가 자기 로그를 볼 수 있어야 하고, 주입된 자격증명이 로그로 새면 안 됨 |
| D5 | 스택은 단일로 두고 **CDK context 모듈 토글**로 분해 | 별도 스택 분리는 마이그레이션 비용이 크고 참조 관리 부담 |
| D6 | 공통 태그 `PhysicalAI=true`를 대시보드·GrootFinetune·IsaacLab 스택에 추가, 대시보드는 이 태그로 리소스 조회 | 부모 스택 `Project` 값이 서로 달라 하나의 필터로 묶기 어려움 |
| D7 | Cost Explorer는 1시간 인프로세스 캐시 | 개요 화면이 이미 같은 방식 사용 |

## 3. 하위 프로젝트와 순서

```
A 즉시 효과 ──► B 로그 ──► C 모듈화+태그 ──► D 리소스 화면 ──► E HTTP+Cognito 로그인 ──► F 경로 게이트웨이
                                   │                                   │
                                   └── D는 C의 태그에 의존             └── F는 E의 HTTP origin에 의존
```

각 하위 프로젝트는 독립적으로 커밋·배포 가능해야 한다. A~D는 기존 도메인 배포에 **diff 없음**(A의 캐시, B의 env 제거는 예외)을 목표로 한다.

---

## 4. A — 즉시 효과

### 4.1 Cost Explorer 캐시
- `web/src/server/aws/cost.ts`: `last30DaysByService()`를 감싸는 `cachedAccountCost()` 추가. 모듈 스코프 `{ at, value }` 캐시, TTL 3,600,000 ms. 실패 시 이전 값이 있으면 그것을 돌려주고 `stale: true`를 붙인다.
- `services/overview.ts`의 `costCache`는 새 함수를 사용하도록 교체(중복 캐시 제거).
- `app/api/cost/route.ts`: 응답 헤더 `Cache-Control: private, max-age=600`.
- `components/pages/AdminPage.tsx`: `refetch: 60000` → `600000`.
- 테스트: `cost.test.ts` — 두 번 호출 시 SDK 1회, TTL 경과 후 2회, 실패 시 stale 반환.

### 4.2 문서 정리
- `dashboard/docs/dashboard-features-and-aws-architecture.md`: 상단 안내문(6행), §1 오케스트레이션 행(55행), §4.4 2~3단계(169~170행), §20 웹훅 주석(445행), §24 표의 Step Functions·SQS/EventBridge 행(510~511행), §25 env 목록(522행)의 `WORKFLOW_STATE_MACHINE_ARN/QUEUE_URL/CALLBACKS_TABLE`, §26 오케스트레이션·보안 하드닝 항목(531행 이하, WAF·알람은 이미 적용됨).
- `dashboard/docs/diagrams/gen_diagrams.py`: 00 전체 아키텍처(331~373행)와 02 실행 워크플로(428~462행)에서 SFN/SQS/EventBridge 노드·엣지 제거, DynamoDB 라벨의 "+ callbacks 테이블" 제거. `export.sh`로 PNG 재생성.
- `dashboard/docs/diagrams/README.md:38` 항목 삭제.
- 과거 설계·계획 문서(`docs/designs/2026-09-16…`, `docs/plans/…`)는 이력이므로 수정하지 않는다.

---

## 5. B — 로그 아카이브 제거

### 5.1 삭제
- `web/src/server/logs/`: `archive.ts`, `collector.ts`, `capture.ts`, `cursors.ts`, `kubernetes.ts`, `http.ts`, `retained.ts`와 각 테스트. `index.ts`는 남는 모듈만 export.
- `web/src/server/workflow-adapters/logs.ts`(+test). `dependencies.ts`의 `LOG_ARCHIVE_ENABLED` 분기와 `logs` 훅. `workflow/ports.ts`의 `ControllerDeps.logs`, `execution.ts`의 `deps.logs?.reconcile/drain` 호출.
- `workflow/controller.ts:52`의 `LOG_ARCHIVE_ENABLED` 게이트 → `ensureAttemptSecret`은 **항상** 배선(redaction 유지를 위해).
- 클라이언트 `components/workflows/log-replay.ts`(+test), `LogViewer.browser.test.ts`의 커서 재접속 케이스.
- `web/e2e/log-archive.spec.ts`. CLI `cli/pai.py`의 `LogCursorFile`·`replay_logs`, `cli/tests/test_log_replay.py`.
- env: `config.ts` ENV_KEYS의 `LOG_ARCHIVE_ENABLED`, `infra/lib/dashboard-stack.ts:116`, `web/scripts/dev-local.sh:96`.
- 기존 DDB `LOG#`·`LOG_POD#`·`LOG_CURSOR#`·`LOG_DRAIN#`·`WF#…/LOG_CAPTURE_STATUS` 아이템은 TTL(30일/1시간)로 소멸. 마이그레이션 없음.

### 5.2 신설: `web/src/server/logs/stream.ts`
```ts
export interface LogTarget { namespace: string; podName: string; podUid: string; attempt: number; member: number; containers: string[]; phase?: string }
export interface LogLine { ts: string; text: string }            // ts = kubelet timestamps=true 의 RFC3339
export interface LogSnapshot { source: 'kubernetes' | 'none'; reason?: 'pod-gone' | 'not-started'; phase?: string; target?: LogTarget; container?: string; targets: LogTarget[]; lines: LogLine[]; truncated: boolean; redaction: 'applied' | 'unavailable' | 'none' }

export function targetsFromPods(pods: Pod[]): LogTarget[]                                   // 라벨 pai.aws/attempt, batch.kubernetes.io/job-completion-index
export async function resolveTargets(workflow: Workflow, taskName: string): Promise<LogTarget[]>   // listPods(ns, managed-by + workflow-id + task 셀렉터)
export function pickTarget(targets: LogTarget[], want: { attempt?: number; member?: number }): LogTarget | undefined
export function pickContainer(target: LogTarget, want?: string): string
export async function readLogs(target: LogTarget, container: string, opts: { tail?: number; sinceTime?: string; redactor?: SecretRedactor }): Promise<{ lines: LogLine[]; truncated: boolean }>
export function followLogs(target: LogTarget, container: string, opts: { tail?: number; sinceTime?: string; redactor?: SecretRedactor; signal: AbortSignal }): AsyncIterable<LogLine>
```
- `readLogs`/`followLogs`는 `k8s/resources.ts`의 `podLogs`/`streamPodLogs`를 확장해 `sinceTime`을 지원하고, 줄 단위로 나눈 뒤 `SecretRedactor`(기존 `redaction.ts` 유지)를 통과시킨다. 첫 줄의 타임스탬프 파싱 실패 시 해당 줄은 `ts: ''`로 전달한다.
- 상한: `tail` 기본 1,000, 최대 5,000. 스냅샷 1 MiB. follow 스트림은 연결당 최대 55초 후 `end` 이벤트로 종료(ALB idle timeout 이내), 클라이언트가 `Last-Event-ID`(마지막 `ts`)로 재접속하면 `sinceTime`으로 이어 받는다. 같은 타임스탬프의 중복 줄은 클라이언트가 `ts+text`로 제거한다.
- Pod가 없으면 `{ source: 'none', reason: 'pod-gone', lines: [] }`. 시도가 아직 Pod를 만들지 않았으면 `reason: 'not-started'`.

### 5.3 API
- `GET /api/workflows/[id]/tasks/[task]/logs?attempt&member&container&tail&since&follow=1`
  - 권한: 기존 `logs/auth.ts`의 `authorizeLogs`(프로젝트 접근 + API 토큰 `workflows:read`) 유지.
  - redaction: `workflow-adapters/log-secrets.ts`의 `injectedLogSecrets`로 redactor 생성. Secret 검증은 Pod 자신의 `pai.aws/epoch`·`pai.aws/attempt` 라벨과 비교한다(태스크 레코드의 최신 시도 값이 아님). redactor를 만들 수 없으면(구버전 실행 등) **비관리자는 403 `log_redaction_unavailable`**, 관리자는 `redaction: 'unavailable'`로 원문을 본다(D4: 자격증명은 절대 새지 않는다).
  - `follow=1` + `Accept: text/event-stream` → SSE. 이벤트: `line` (data=`LogLine` JSON, id=`ts`), `end` (data=`{reason:'timeout'|'pod-ended'}`), `log-error`.
  - 그 외 → `LogSnapshot` JSON.
- `GET /api/k8s/pods/[ns]/[name]/logs?container&tail&since&follow=1`: 같은 모듈 사용. 권한은 `assertNamespaceAccess`(viewer). `source=retained` 파라미터와 관리자 전용 분기 제거(단일 경로).
- 호환: e2e `isaaclab.spec.ts:389-392`는 `?tail=120` 후 `.source`·`.lines`를 읽는다. `lines`는 이제 `LogLine[]`이므로 스펙을 `lines.map(l => l.text)`로 갱신한다.

### 5.4 UI
- `LogViewer.tsx`: 스트림 선택은 `targets`(시도·멤버·컨테이너·Pod 이름)로, 상태 배지는 `live | ended | pod-gone | not-started`. `follow` 토글은 RUNNING 태스크에서만 기본 켬. 클라이언트 표시 상한 10,000줄 유지. 커서·gap·archived 문구 삭제.
- `JobsPage.tsx`: 관리자 `retained` 체크박스 삭제, 같은 뷰어 재사용.
- i18n `logs.ts`·`jobs.ts`: 아카이브 문구를 "Pod가 살아 있는 동안만 표시되며 삭제 후에는 K8s에 보존된 로그가 없습니다"로 교체(ko/en).

### 5.5 CLI
- `pai workflows logs RUN --task T [--attempt N] [--member M] [--container C] [--tail N] [--follow]`. `--follow`는 SSE를 `http.client`로 스트리밍 읽고 `id:`를 기억해 재접속. `--start`, `--stream`, `--cursor`, `--cursor-file` 제거. README 갱신.

### 5.6 테스트
- 단위: `stream.test.ts`(줄 분할·타임스탬프·redaction·sinceTime 전달), 라우트 테스트(권한, pod-gone, SSE 프레이밍, 55초 종료), `LogViewer` 브라우저 테스트(재접속 시 `Last-Event-ID`).
- e2e: `log-stream.spec.ts` — 실행 중 태스크의 follow, 종료 후 Pod 삭제 시 `pod-gone` 안내.
- CLI: `test_log_stream.py`.

---

## 6. C — 스택 모듈화와 공통 태그

### 6.1 모듈 계약 (`infra/lib/modules.ts`)
```ts
export interface DashboardModules {
  ingress: { mode: 'https' | 'http'; domainName?: string; hostedZoneId?: string; hostedZoneName?: string };
  gateway: boolean;                               // 세션 게이트웨이 서비스 + 리스너 규칙
  images: { build: WorkloadImageName[]; overrides: Partial<Record<WorkloadImageName, string>> };
  sourceBuild: boolean;                           // CodeBuild + ECR
  edge: boolean;                                  // Greengrass IAM + env
  waf: boolean;
  alarms: boolean;
  resourceTag: { key: string; value: string };    // 기본 PhysicalAI=true
}
export function resolveModules(ctx: (k: string) => unknown): DashboardModules   // 검증·기본값·오류 메시지
export function describeModules(m: DashboardModules): string                     // synth 시 stderr 요약
```
- context 키: `domainName`·`hostedZoneId`·`hostedZoneName`(모두 있으면 https, 모두 없으면 http, 일부만 있으면 오류), `gateway=false`, `images=mujoco,ros2`(기본 `mujoco,isaaclab,ros2,workspace`; `extendedImages=true`는 `groot,openpi` 추가로 유지), `imageOverrides='{"mujoco":"<ecr-uri@sha256:…>"}'`, `sourceBuild=false`, `edge=false`, `waf=false`, `alarms=false`, `resourceTagKey`, `resourceTagValue`. 기존 `optionalImages`, `eksBackends`, `workflowNamespaces`, `notifyEmail`, `vpcId`는 그대로.
- 기본값은 **현재 배포와 동일**. `cdk diff`가 태그 추가와 env 변경 외에 자원 변화를 보이면 안 된다.

### 6.2 construct 분해
- `constructs/service.ts` → `ingress.ts`(ALB, 리스너, 인증서·DNS·Cognito 액션은 https 모드에서만, WAF 옵션), `web-service.ts`, `controller-service.ts`, `gateway-service.ts`(옵션). 공통 태스크 이미지·로그 그룹·클러스터는 `cluster.ts`.
- `WorkloadImages`: `build` 목록만 `DockerImageAsset` 생성, `overrides`는 URI 그대로 env로. 두 곳 모두 `*_IMAGE_URI` env를 채운다. 목록에 없는 이미지는 env 없음 → 앱의 `required://ENV` 검사가 기존처럼 "이미지 준비 필요"를 안내.
- `SourceBuildProject`가 꺼지면 `SOURCE_BUILD_TARGETS_JSON`·`BUILD_PROJECTS`의 자체 프로젝트가 빠진다. 앱은 `features.builds`가 없을 때 빌드 화면을 숨겨야 한다(현재 `BUILD_PROJECTS` 빈 문자열 처리 확인 후 필요 시 보강).
- `edge=false`: `GREENGRASS_*` env와 IoT/Greengrass IAM 생략 → `features.edge=false`.
- `dashboard-stack.ts`는 모듈 객체를 받아 각 construct를 조건부로 조립하는 100행 이하의 조립 코드로 줄인다.

### 6.3 태그
- `infra/bin/app.ts`: `cdk.Tags.of(app).add(resourceTag.key, resourceTag.value)`. 기존 `Project`·`ManagedBy`·`UserId` 유지.
- `e2e-workshop/infra/groot/bin/*.ts`, `e2e-workshop/infra/isaaclab/bin/*.ts`: 동일 태그 추가(값 고정 `PhysicalAI=true`).
- 대시보드 env: `RESOURCE_TAG_KEY`, `RESOURCE_TAG_VALUE`.
- HyperPodEks 스택은 이 저장소 밖이므로 README에 "`PhysicalAI=true` 태그를 추가하면 리소스 화면에 표시됩니다"를 적는다.

### 6.4 테스트
- `infra/test/modules.test.ts`: 기본값, 일부 도메인 키 누락 오류, `images` 파싱, `imageOverrides` URI 검증.
- `infra/test/stack-modules.test.ts`: `gateway=false`면 `AWS::ECS::Service` 2개, 리스너 규칙에 gateway 없음; `waf=false`면 `AWS::WAFv2::WebACL` 0; `images=mujoco`면 이미지 asset 수; http 모드는 §8에서 검증.

---

## 7. D — 리소스 화면

- `web/src/server/aws/tagged-resources.ts`: `tag:GetResources`(`TagFilters=[{Key, Values}]`, 페이지네이션) → ARN을 `service/type/name/region`으로 파싱. EC2 인스턴스는 `DescribeInstances`로 상태·타입·AZ·Name 태그·프라이빗 IP·시작 시각 보강. 60초 모듈 캐시. 실패는 `{ error }`로 그룹 단위 표기.
- `GET /api/resources`(viewer) → `{ tag: {key, value}, fetchedAt, groups: [{ service: 'EC2'|'FSx'|'EKS'|'S3'|'SageMaker'|'DynamoDB'|'ECS'|'Other', items: [{ arn, type, name, region, consoleUrl, details? }] }] }`.
- IAM: 웹 태스크 역할에 `tag:GetResources`(리소스 `*`). `ec2:DescribeInstances`는 이미 있음. 시작·중지 없음.
- UI: `/resources` 페이지(`components/pages/ResourcesPage.tsx`), 사이드바 `groupCluster`에 추가, 서비스별 접이식 표, 콘솔 링크. `features` 게이트 없음(태그는 항상 설정됨). i18n 네임스페이스 `resourcesPage`(기존 `resources`와 충돌 회피).
- 테스트: 파서 단위 테스트, 라우트 캐시 테스트, `route-slugs.test.ts` 갱신, 하드코딩 문자열 테스트 통과.

---

## 8. E — 도메인 없는 HTTP 모드 + 앱 내 Cognito 로그인

### 8.1 인프라 (`ingress.mode === 'http'`)
- 리스너 HTTP :80 → web 타깃 그룹 기본 forward. ACM·Route 53·`AuthenticateCognitoAction`·80→443 리디렉션 없음.
- Cognito: 기존 `AlbClient`는 https 모드에서만 생성. 두 모드 공통으로 **`AppClient`** 추가: `generateSecret: false`, `authFlows: { userPassword: true, userSrp: true }`, OAuth 블록 없음, 토큰 유효기간 access/id 1h, refresh 30d. env `COGNITO_APP_CLIENT_ID`.
- 세션 서명 키: Secrets Manager `SessionSigningSecret`(64자) → 컨테이너 secret `SESSION_SIGNING_KEY`.
- env: `AUTH_MODE=cognito`, `DASHBOARD_ORIGIN=http://<ALB DNS>`(`loadBalancerDnsName` 토큰). `ALB_ARN`·`COGNITO_DOMAIN`은 http 모드에서 생략.
- WAF는 옵션 그대로(HTTP ALB에도 적용 가능). 로그인 엔드포인트에 rate 규칙은 기존 2000/IP 규칙으로 충분.

### 8.2 앱
- `config.ts`: `AuthMode = 'alb' | 'cognito' | 'dev'`. `cognito`는 `COGNITO_USER_POOL_ID`, `COGNITO_APP_CLIENT_ID`, `SESSION_SIGNING_KEY`, `DASHBOARD_ORIGIN` 필수.
- 쿠키 `pai-auth`: HttpOnly, SameSite=Lax, Path=/, `Secure`는 origin이 https일 때만. 값은 `jose` HS256 JWT `{ at: accessToken, rt: refreshToken, exp }` (서명 키 = `SESSION_SIGNING_KEY`). 크기 약 3 KB, ALB 헤더 한도 내.
- `web/src/proxy.ts`(미들웨어)에 `cognito` 분기:
  1. 쿠키 없음/서명 불일치 → `/api/*`는 401 JSON, 그 외는 `/login?next=<path>` 302.
  2. access token을 기존 `readGroupsFromAccessToken`(JWKS, 캐시)로 검증 → `x-pai-*` 헤더 설정, `authMethod: 'cognito'`.
  3. access 만료·refresh 유효 → `InitiateAuth(REFRESH_TOKEN_AUTH)` 후 새 쿠키를 응답에 실어 계속 진행. 실패 시 1번과 동일.
  4. `/login`, `/api/auth/login`, `/api/auth/challenge`, `/api/health`, `/api/logout`, `/api/v1/*`(토큰)는 공개.
- 라우트: `POST /api/auth/login {username, password}` → `InitiateAuth(USER_PASSWORD_AUTH)`. `NEW_PASSWORD_REQUIRED` 챌린지는 `{ challenge: 'NEW_PASSWORD_REQUIRED', session }`로 돌려주고 `POST /api/auth/challenge {session, username, newPassword}` → `RespondToAuthChallenge`. 성공 시 쿠키 설정, 감사 `auth.login`.
- `GET /api/logout`: `cognito` 모드에서는 `RevokeToken(refresh)` 후 쿠키 삭제, `/login`으로 302. `alb` 모드는 기존 동작.
- `/login` 페이지: 사용자명·비밀번호 폼, 새 비밀번호 폼(챌린지 시), 오류 문구 ko/en. 스타일은 기존 Cognito 관리형 로그인 다크 테마와 맞춘다.
- `auth/session.ts`: `authMethod` 유니온에 `'cognito'` 추가. `sessionFromHeaders`의 기본값 처리 갱신.
- `request-policy.ts`·`api/logout`·게이트웨이 `DASHBOARD_ORIGIN` 정규식: `http://` 허용.

### 8.3 테스트
- 미들웨어 단위: 쿠키 없음 → 302/401, 유효 → 헤더, 만료+refresh → 새 쿠키, 위조 서명 → 401.
- 라우트: login 성공·실패·챌린지, logout revoke.
- CDK: http 모드에서 `AWS::CertificateManager::Certificate` 0, `AWS::Route53::RecordSet` 0, 리스너 포트 80, `AuthenticateCognitoConfig` 없음, `AppClient` `ExplicitAuthFlows` 포함.
- e2e: `AUTH_MODE=cognito` 로컬 실행에서 로그인 → `/api/me` 역할 확인.

---

## 9. F — 경로 기반 세션 게이트웨이

### 9.1 모드
- `GATEWAY_MODE=host|path`. https 모드 기본 `host`(현재 동작 유지), http 모드는 `path` 강제. `GATEWAY_PUBLIC_ORIGIN`: path 모드에서 `http://<ALB DNS>:8080`.
- 인프라: path 모드는 ALB에 **리스너 :8080**(HTTP) → gateway 타깃 그룹 기본 forward. ALB 보안그룹에 8080 인바운드. 대시보드 :80과 origin이 다르므로 세션 앱 XSS가 대시보드 쿠키에 닿지 않는다. 브라우저 same-site 판정은 포트를 무시하므로 iframe 안 세션 쿠키(SameSite=Strict)는 동작한다.

### 9.2 게이트웨이 변경 (`web/src/server/gateway/`)
- `auth.ts`: `sessionIdFromPath(pathname) → { id, rest }`, 티켓·쿠키 grant의 `host` 바인딩을 `origin + '/s/' + id` 문자열로 일반화(host 모드는 기존 값). 티켓 URL `${publicOrigin}/s/${id}/?ticket=`. 쿠키 이름 `pai-session-<id>`, `Path=/s/<id>/`, `Secure`는 https일 때만, `SameSite=Strict`, `__Host-` 접두어는 host 모드에서만.
- `server.ts`: `requestUrl()`이 모드에 따라 host 또는 path에서 id를 얻고, path 모드에서는 upstream으로 보내기 전 접두어를 제거. `checkOrigin()`의 기대 origin은 `GATEWAY_PUBLIC_ORIGIN`. 티켓 교환 303은 `/s/<id>/<rest>`로.
- `headers.ts`: `X-Forwarded-Prefix: /s/<id>`, `X-Forwarded-Proto`는 실제 스킴. `Location`이 루트 상대(`/…`)면 접두어를 앞에 붙임. upstream `Set-Cookie`의 `Path=/`를 `Path=/s/<id>/`로 재작성, `__Host-` 접두 쿠키는 이름을 `pai-app-` 로 바꿈. `Secure` 강제는 https일 때만. DCV `frame-ancestors`는 `DASHBOARD_ORIGIN`(http 허용).
- `terminal.ts`·`browser/terminal-client.js`: 자산·WS 경로를 상대경로(`__gateway/…`)로.
- `lifetime.ts`: 재검증 바인딩 문자열 전달.
- 업스트림: `session-image/session.py`에 `PAI_SESSION_PREFIX` env(`/s/<id>` 또는 빈 문자열)를 받아 Jupyter `--ServerApp.base_url=<prefix>/`, TensorBoard `--path_prefix=<prefix>`. `services/sessions.ts:157`에서 env 주입. code-server는 변경 없음. `workflow/live-view.ts` 페이지의 `/stream`·`/status.json`을 상대경로로. `runtime/files_linux.go`의 HTML 링크를 상대경로로.
- DCV: 접두어 제거 후 그대로 전달. 절대경로 자산이 깨지면 path 모드에서는 "새 창으로 열기"만 제공하고 iframe 임베드는 host 모드로 한정한다. 이 판정은 구현 단계의 실측으로 결정하고 README에 기록한다.

### 9.3 대시보드
- `TaskConnections.tsx:172`, `DcvBrowserCard.tsx:30`: 검증을 "URL origin === `me.gatewayOrigin` && pathname이 `/s/<id>/`로 시작" 또는 host 모드 기존 검사로 분기. `/api/me`에 `gateway: { mode, origin }` 추가.
- `features.sessions`는 `GATEWAY_BASE_DOMAIN` 또는 `GATEWAY_PUBLIC_ORIGIN` 중 하나가 있으면 참.

### 9.4 테스트
- `auth.test.ts`·`server.test.ts`·`headers.test.ts`: path 모드 픽스처(접두어 제거, Location·Set-Cookie 재작성, 티켓 교환, WS 업그레이드).
- `session-image/test_session_image.py`: prefix 인자 확인.
- e2e: path 모드에서 Jupyter·터미널·실시간 보기 열기. DCV는 실측 후 결정.

---

## 10. 문서와 운영

- README(dashboard): 설치 절에 두 가지 배포 예시(도메인 있음/없음), 모듈 옵션 표, 태그 안내, 로그 동작 변경("Pod 삭제 후 이력 없음"), CLI logs 변경.
- `docs/dashboard-features-and-aws-architecture.md`: §1 구성 요소(모드별), §2 인증(두 모드), §4.3 로그 행, §9 세션(경로 모드), §12 작업 로그, §24 API 표(Cost Explorer 캐시, Tagging API 추가, 로그 관련 DDB 삭제), §25 env 계약, §26 제한.
- 다이어그램 00·01·02·05 재생성.
- 운영 메모: 기존 배포에 B를 배포하면 controller가 더 이상 `LOG#`를 쓰지 않으며 남은 아이템은 30일 내 TTL 소멸. E·F는 새 계정에서 http 모드로 검증하고 기존 도메인 배포는 host 모드로 유지한다.

## 11. 범위 밖 (이번에 하지 않음)

- controller 5초 tick이 종료 워크플로의 outbox를 매번 Query하는 구조 개선(sparse GSI). 별도 후속.
- 모든 DDB 읽기의 `ConsistentRead` 완화.
- CloudWatch Logs로 Pod 로그 수집(Fluent Bit). 사용자가 kubelet 실시간만을 선택.
- EC2 시작·중지 등 리소스 화면의 쓰기 동작.
- 별도 CloudFormation 스택 분리.
