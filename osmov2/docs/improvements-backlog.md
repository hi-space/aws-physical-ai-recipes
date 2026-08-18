# 개선 백로그 (Improvements Backlog)

OSMO 배포/파이프라인 운영 중 발견한 개선 항목 모음. 우선순위나 담당자와 무관하게
"나중에 손봐야 할 것"을 잊지 않도록 기록한다.

작성 시작: 2026-08-03

---

## 0. 운영 주의: `osmo config show`는 시크릿을 마스킹해서 출력한다

`osmo config update`를 손으로 할 때 흔히 쓰는 read-modify-write 패턴이 시크릿을
파괴할 수 있다.

```bash
# 위험 — access_key가 "**********"로 덮인다
osmo config show WORKFLOW | jq '.some_key = "new"' > /tmp/c.json
osmo config update WORKFLOW --file /tmp/c.json
```

`osmo config show`는 `workflow_data.credential.access_key` 같은 시크릿 필드를
`**********`로 마스킹해서 내보내는데, 그 출력을 그대로 되먹이면 마스킹 문자열이
저장된다. `osmo config diff`도 같이 마스킹하므로 diff로는 사고를 감지할 수 없다.

`osmo config update`는 깊은 병합(deep merge)이다 — WORKFLOW revision 2→3에서
`jq -n`으로 `workflow_data.base_url`만 보냈는데 형제 키
(`websocket_timeout`/`data_timeout`/`download_type`)가 모두 살아남았다. 그래서
안전한 방법은 바꿀 키만 보내는 것이다.

```bash
# 안전 — 바꿀 키만 (병합이 나머지를 보존)
jq -n '{user_workflow_limits: {max_num_workflows: 2}}' > /tmp/c.json
osmo config update WORKFLOW --file /tmp/c.json
```

시크릿을 포함한 블록을 꼭 다시 써야 한다면 마스킹된 값이 아니라 Secrets Manager의
실제 값을 넣어야 한다(`deploy-osmo.sh`의 `secret_field`가 하는 방식). POOL 설정에는
마스킹되는 필드가 없어 read-modify-write가 안전하다.

시크릿을 덮었는지 확인하려면 CPU 워크플로를 하나 제출해 본다. 로그에
`Validating data access permissions... All data access validations passed`와
`Upload Start`가 보이면 자격증명이 살아 있다.

---

## 1. 로그인 시 Cognito ID 체계가 다르게 보이는 부분 — 레시피 반영 완료 (2026-08-18)

해결: 방안 A + B를 함께 적용했다. `preferred_username`을 단일 OSMO 사용자 ID로
삼아 UI 표시, "My Workflows" 필터, 워크플로우 owner, `osmo user list`가 모두 같은
읽을 수 있는 문자열(이메일 로컬 파트, 예: `admin`)을 쓴다.

- `scripts/deploy-osmo.sh`: gateway Envoy cognito provider `user_claim: sub` →
  `preferred_username`. `OSMO_SSO_ADMIN_SUB` → `OSMO_SSO_ADMIN_NAME`
  (`admin_user_name` 출력값 사용)로 역할 부여 대상 변경.
- `scripts/add-osmo-user.sh`: OSMO 사용자 키를 sub → Cognito에서 되읽은
  `preferred_username` 속성값으로 변경.
- `infra/cognito/outputs.tf`: `admin_user_name` 출력 추가. `admin_user_sub`는
  풀 내 조회용으로 남기되 "더 이상 OSMO 사용자 ID 아님"으로 문서화.
- `infra/cognito/main.tf`: 변경 없음 — 최초 admin에 이미
  `preferred_username = split("@", admin_email)[0]`을 설정하고 있었다.
- `README.md` / `README.ko.md` / `infra/cognito/README(.ko).md`: sub 기준 설명 수정.
- 방안 C(CLI `unique_name`까지 통일)는 osmo-service 토큰 발급 로직 변경이라
  upstream 의존. 미적용 — CLI 서비스 토큰으로 제출한 잡의 owner는 여전히
  `admin`/`testuser`다.

라이브 클러스터 적용은 gateway Helm upgrade가 필요하며 아직 하지 않았다. 적용 시
기존 sub 키 OSMO 사용자(`a41824c8-...`) 1건과 그 소유 워크플로우가 새 필터값으로는
안 보이므로, 해당 사용자를 `admin`으로 재생성할지 무시할지 결정해야 한다.

라이브 재현 (2026-08-18, use1) — 미적용 상태의 증상을 실측했다:
- `add-osmo-user.sh osmouser-test@osmo.local`로 사용자 생성 → OSMO 사용자
  `osmouser-test`에 `osmo-user` 부여 성공(수정한 스크립트 정상 동작 확인).
- `osmo-cli-login.sh`로 로그인 → Cognito SRP 인증 성공, ID 토큰에
  `preferred_username: osmouser-test` 정상 포함.
- 그런데 `osmo workflow list`가 `403 access denied`. 게이트웨이 로그가 원인을
  확정한다: `osmo_user: 846814e8-...(sub)`, `ext_authz_denied`,
  `authz-sidecar: synced user roles added=[osmo-default] ... access denied`.
  즉 Envoy가 sub를 `x-osmo-user`로 보내 `idp-sync`가 그 UUID를 **별개의** OSMO
  사용자로 새로 만들고, 부여한 역할은 `osmouser-test` 레코드에 남아 무용지물이 된다.
  → 사용자를 올바르게 프로비저닝해도 게이트웨이 claim이 sub인 동안은 제출이 불가능.
- 참고: 이 상태로 사용자를 추가할 때마다 OSMO에 UUID 사용자가 하나씩 늘어난다
  (`osmo user list`가 오염됨). 전환 후에는 이 UUID 레코드들을 정리해야 한다.
- 별도로 `osmo-user` 자체의 권한은 충분함을 확인했다: 관리자가
  `osmo token set <name> --user <user>`로 발급한 토큰으로 로그인하면(게이트웨이
  claim 문제를 우회) `osmo-user`가 스모크 워크플로를 제출해 `COMPLETED`까지 가고
  owner가 본인 이름으로 기록된다. `osmo user list`/`osmo config show`는 403.
  즉 남은 문제는 순수하게 게이트웨이 claim 매핑뿐이다.

`add-osmo-user.sh`에 토큰 발급(`--token`)을 넣는 안을 구현해 라이브 검증까지 했으나
채택하지 않고 되돌렸다. 게이트웨이 claim이 sub인 동안에도 CLI가 동작하는 유일한
경로여서 매력적이었지만, 토큰을 사용자에게 전달하는 문제가 비밀번호보다 나쁘다:
문자열이 발급 순간에만 출력돼 별도 채널로 옮겨야 하고, 사용자가 스스로 회전할 수
없고, 발급 시점 역할이 고정돼 나중에 권한을 줄여도 남고, `osmo token set`이 같은
이름 재사용을 거부해(400 `already exists`) 회전이 `delete --user` 후 재생성이다.
결론: 게이트웨이를 `preferred_username`으로 올리고 사용자는 본인 Cognito 비밀번호로
`osmo-cli-login.sh`를 쓴다. 토큰은 디버깅 도구로만 문서에 남겼다.
CLI 실측 메모 — `--user` 없는 `osmo token list`/`delete`는 호출자 본인 토큰만
대상으로 하며 타 사용자 토큰은 "does not exist" 400을 낸다. 기본 만료는 31일.

아래는 진단 기록이다.

증상
- OSMO Admin UI에 Cognito SSO로 로그인하면, UI/CLI에서 표시되는 사용자 식별자가
  로그인할 때 입력한 이메일이 아니라 Cognito subject(UUID, `sub`)로 보인다.
- `osmo user ...` 명령이나 workflow submitter 필드에서도 사람이 읽기 어려운
  UUID 형태로 나타나 "누가 무엇을 했는지" 파악이 번거롭다.

배경 / 원인 추정
- oauth2-proxy가 OIDC로 받은 토큰의 subject(`sub`) 클레임을 OSMO 사용자 ID로
  사용한다. `deploy-osmo.sh`도 Cognito `admin_user_sub`(=UUID)에 `osmo-admin`
  역할을 부여하는 구조라, OSMO 내부 식별자는 이메일이 아닌 sub 기반이다.
- 관련 문서: `infra/cognito/README.md` (Initial login user / admin_user_sub 설명).

근본 원인 조사 완료 (2026-08-03, 라이브 + NVIDIA/OSMO 소스 확인)
- 실증 케이스: UI가 `user:a41824c8-c021-7069-1f51-1d2b9a320991`로만 조회 → 실제
  워크플로우 owner(`testuser`, CLI는 `admin`)와 안 맞아 목록이 비거나 어긋남.
  - 이 UUID를 Cognito에서 역조회하면 `admin@osmo.local` (user_pool us-east-1_VsXQ6MpoR).
- 두 개의 서로 다른 정체성 체계가 공존한다:
  - 웹 SSO 경로: gateway Envoy jwt provider(cognito)가 `user_claim: sub`
    (`deploy-osmo.sh` L347-355) → 워크플로우 owner를 `x-osmo-user`=sub(UUID)로 기록.
  - CLI 토큰 경로: osmo-service 발급 토큰의 `unique_name`(`deploy-osmo.sh` L346)
    → owner가 `admin`/`testuser` 등 사람이 읽는 이름.
  - 같은 관리자라도 웹=UUID, CLI=이름으로 갈려 서로의 워크플로우가 상대 필터에 안 잡힘.
- 결정적: UI의 "My Workflows" 필터가 쓰는 정체성은 Envoy의 `x-osmo-user`(=sub)가
  아니라 oauth2-proxy 헤더 `x-auth-request-preferred-username`이다.
  (`src/ui/src/lib/auth/server.production.ts` L43,48: getServerUsername =
   `x-auth-request-preferred-username || x-auth-request-user`;
   `.../workflows/list/components/workflows-toolbar.tsx` L81-91: My Workflows 프리셋이
   `user:${currentUsername}` 칩을 만듦.)
  → gateway 주석(L351-354, "UI가 sub로 필터하므로 owner도 sub여야 한다")의 전제는
    이 UI 버전에서는 틀렸다. UI 표시/필터는 preferred_username, owner 기록은 sub.
- 왜 하필 sub가 뜨나: Cognito `admin@osmo.local`에는 `preferred_username` 속성이
  아예 없다(email/email_verified/sub만 존재). oauth2-proxy는 preferred_username
  클레임이 없으면 sub로 폴백 → UI가 `user:<sub>`로 필터.
- OSMO에는 표시명 메커니즘이 이미 있다(`src/ui/src/lib/auth/README.md`):
  `x-auth-request-email`(email), `x-auth-request-name`(JWT `name` claim, Envoy Lua),
  `x-auth-request-preferred-username`(username). 즉 UI는 UUID가 아니라 이름/이메일을
  보여줄 수 있게 설계돼 있으나, 우리 IdP가 해당 클레임을 안 채워서 sub로 떨어짐.

개선 방안 상세 검토
- 방안 A (권장, 저위험): Cognito 사용자에 `preferred_username`(또는 최소 email 노출)
  을 채우고, oauth2-proxy가 그 클레임을 x-auth-request-preferred-username으로
  전달하도록 확인.
  - 효과: UI "My Workflows" 필터와 표시가 사람이 읽는 값이 됨(UUID 탈출).
  - 주의: 이건 UI 필터(preferred_username)만 바꿀 뿐, 워크플로우 owner 기록
    (`x-osmo-user`=sub)은 그대로다. 즉 "표시/내 잡 필터"는 개선되지만, 웹에서 만든
    잡(owner=sub)과 CLI에서 만든 잡(owner=unique_name)의 owner 문자열 불일치는 남음.
  - OSMO 공식 IdP 가이드도 `user_claim: preferred_username`을 표준 예시로 제시
    (`docs/.../identity_provider_setup.rst` L111; Google은 email, L148).
- 방안 B (owner 통일, 중위험): gateway cognito provider `user_claim`을 sub→email
  (또는 preferred_username)로 변경.
  - 효과: 웹 워크플로우 owner가 사람이 읽는 값이 됨.
  - 트레이드오프: gateway 주석 경고대로, "기존 sub로 만들어진 잡"이 새 필터값으로는
    안 보이게 됨(마이그레이션 필요). 또한 CLI(unique_name=admin)와 웹(email=
    admin@osmo.local)은 여전히 문자열이 달라 완전 통일은 아님.
  - IdP role 매핑(`admin_user_sub`에 osmo-admin 부여, infra/cognito)이 sub 기준이면
    이쪽도 함께 재검토 필요.
- 방안 C (완전 통일, 고위험/upstream): CLI 토큰의 unique_name까지 sub(또는 email)로
  맞춰 웹/CLI owner를 단일화. osmo-service 토큰 발급 로직 변경이라 upstream 의존적.
- 최소(무코드): 문서에 "UI에 뜨는 UUID=Cognito sub, admin@osmo.local이며 이메일은
  Cognito 콘솔/CLI에서 역조회" + "CLI 제출 잡은 owner=unique_name이라 웹 My Workflows
  필터에 안 잡힐 수 있음" 명시.

채택: 방안 A와 B를 분리하지 않고 한 번에 적용했다. A만 하면 UI 표시는 사람이 읽게
되지만 owner는 여전히 sub라 두 문자열이 갈린 상태가 유지되고, 나중에 B를 하면
그때 또 마이그레이션이 필요하다. sub 키 OSMO 사용자가 1건뿐이고 기존 워크플로우
20건은 모두 CLI 경로(owner=`testuser`)여서 지금이 마이그레이션 비용이 가장 낮은
시점이었다. 상세는 이 절 맨 위 요약 참고.

---

## 2. 파이프라인 학습 메트릭(epoch/loss 등)을 Grafana로 통합

증상
- GPU 워크플로우 실행 시 Grafana(AMG)에는 DCGM GPU 메트릭(util/VRAM/power/temp)만
  보이고, 학습 스칼라(loss, learning_rate, epoch, step 등 예전 MLflow에서 보던
  값)는 대시보드에 나타나지 않는다.

배경 / 원인
- 학습 잡은 ephemeral pod라 Prometheus가 직접 scrape하기 어렵다. HF Trainer는
  스칼라를 stdout에만 찍는다.
- 저장소에는 이미 Pushgateway 패턴이 존재한다:
  - `scripts/deploy-observability-incluster.sh` (in-cluster 경로에서 Pushgateway
    helm 배포 + `additionalScrapeConfigs`에 pushgateway job, `honor_labels: true`)
  - `examples/isaaclab-rsl-rl-video/workflow-g6*.yaml` (TensorBoard→Pushgateway
    실시간/최종 push, `isaac_*` 메트릭)
  - `versions.yaml`의 `observability_incluster` 블록
    (canonical 서비스명 `aws-osmo-pushgateway-prometheus-pushgateway`)
- 단, AMP+AMG 경로(`scripts/deploy-observability.sh`)에는 Pushgateway가 없다.

PoC 검증 완료 (2026-08-03)
- `03-vla-finetune`(GR00T fine-tune)의 임시 복사본으로 PoC 수행: launch_finetune.py
  stdout을 stdlib 파서(`push_metrics.py`)로 tee하면서 loss/lr/grad_norm/step을
  Pushgateway로 push → Prometheus remote_write → AMP → AMG Grafana까지 도달 확인.
- AMP SigV4 쿼리 결과: `groot_train_loss=1.1076`, `groot_learning_rate=3.02e-06`,
  `groot_grad_norm=2.6554`, `groot_global_step` (workflow 레이블 = pod id).
- 주의: PoC는 bare Service `aws-osmo-pushgateway`(수동 생성)를 사용했으나,
  정식 반영 시에는 canonical 서비스명을 써야 함(위 versions.yaml 참조).

정식화 완료 (2026-08-03)
- 인프라: `scripts/deploy-observability.sh`(AMP+AMG 경로)에도 Pushgateway를 배포하도록
  반영됨 — 위 "AMP 경로엔 Pushgateway 없음" 갭 해소. in-cluster 경로
  (`deploy-observability-incluster.sh`)와 canonical 서비스명
  `aws-osmo-pushgateway-prometheus-pushgateway.monitoring.svc.cluster.local:9091` 동일.
- 대시보드: `AWS OSMO Overview`에 "GR00T training scalars" row(패널 id 11–15) 추가
  (`import_aws_osmo_overview_dashboard`). loss/lr/grad_norm/epoch/step 표시.
- 재사용 가능한 pusher: `scripts/push_metrics.py`를 canonical 복사 원본으로 추출
  (03-vla-finetune의 GR00T 전용 파서를 일반화 — stdlib only, `METRICS_PREFIX`/`METRICS_JOB`/
  `WORKFLOW_ID` env로 스테이지별 커스터마이즈, `PUSHGATEWAY_URL` 비면 순수 tee no-op).
- 가이드: `docs/adding-workflow-metrics.md` (+ `.ko.md`) — 새 파이프라인 스테이지에서
  메트릭을 Grafana에 추가하는 방법 문서화(두 push 패턴, quick start 4단계, 패널 추가,
  검증, 함정). item 2의 "쉽게 하는 방법/가이드" 요청에 대한 답.

남은 커버리지 갭
- 실제로 메트릭을 push하는 스테이지: `03-vla-finetune/workflow.yaml`,
  `03-vla-finetune/workflow-n1.7.yaml`(둘 다 stdout/tee, `job=groot_training`,
  `groot_*` 메트릭 → 대시보드 패널과 일치), `examples/isaaclab-rsl-rl-video`
  (file-export, `isaac_*`).
- 아직 미이식: 나머지 GPU 스테이지 `02-sim-rl`/`04-closeloop`/`06-cosmos-augment`.
  위 가이드(`docs/adding-workflow-metrics.md`)대로 `push_metrics.py`를 인라인
  이식하고 스테이지별 `METRICS_JOB`/`METRICS_PREFIX`를 지정하면 메트릭이 뜬다.
  (01-data-prep은 CPU 전용이라 GPU/학습 메트릭 대상 아님.)

---

## 3. 상세 화면의 output 경로 / 내부 DNS 링크 개선

증상
- OSMO workflow 상세(overview) 화면의 링크가 내부 클러스터 DNS를 가리켜
  브라우저에서 열리지 않는다.
  예: `http://osmo-internal-router.osmo.svc.cluster.local/workflows/<id>`
- 산출물(output) 경로 링크가 죽은 UI 라우트로 연결된다. 실제 데이터셋은
  Datasets 페이지에서 접근해야 한다(outputs 링크로는 도달 불가).

배경 / 원인
- workflow overview URL이 클러스터 내부 서비스 FQDN으로 렌더링됨(공개 도메인/
  CloudFront 주소가 아님).
- outputs 링크가 실제 존재하는 UI 라우트가 아니라 Datasets 페이지가 정답.
- us-west-2 등 일부 리전에는 Grafana(AMG) 자체가 없어 `grafana_url`이 빈 값이
  정상(세팅하면 오히려 403).

근본 원인 조사 완료 (2026-08-03, NVIDIA/OSMO 소스 확인)
- 두 링크는 백엔드가 값을 만들어 DB에 저장하며, 서로 다른 config에서 조립된다
  (`src/utils/job/workflow.py`):
  - Outputs(Artifacts & results) 링크 (L1192-1193):
    `outputs = workflow_data.base_url + "/" + workflow_id` (base_url 비면 빈 문자열).
    우리 배포는 `WORKFLOW.workflow_data.base_url`에 내부 FQDN이 들어가 있어
    `http://osmo-internal-router.osmo.svc.cluster.local/workflows/<id>`가 됨.
  - Overview 링크 / Slack 알림 (L1260-1262):
    `service_base_url`에서 scheme+hostname만 뽑아 `/workflows/<id>`를 붙임.
    소스는 `SERVICE.service_base_url` (역시 내부 FQDN).
- 설정 위치(우리 스크립트): `scripts/deploy-osmo.sh`
  - L80-84: `OSMO_SERVICE_CALLBACK_URL`, `OSMO_WORKFLOW_DATA_BASE_URL` 둘 다
    기본값이 `http://${OSMO_INTERNAL_ROUTER_NAME}.${OSMO_NAMESPACE}.svc.cluster.local`.
  - L612-615(service_base_url), L631-634(workflow_data.base_url)에서 config로 주입.
- UI에는 이미 프록시 재작성 함수가 있다(`src/ui/src/lib/config.ts`의 `toProxiedPath`
  / `toProxiedWsHost`): 백엔드가 내부 host를 반환해도 same-origin(CloudFront) 경로로
  재작성. 로그/이벤트/스펙 스트림에는 적용됨. 그러나 상세화면 Links 섹션의
  Outputs/Overview 하이퍼링크(`workflow-details.tsx` L266 `url: workflow.outputs`)에는
  `toProxiedPath`가 적용되지 않아 내부 FQDN이 그대로 노출됨.

핵심 판단 (base_url 변경으로는 Outputs 링크를 못 고친다 — 2026-08-03 최종 확정)
- `service_base_url`(=Overview 링크 소스)은 워크플로우 컨트롤플레인 콜백(agent→
  service, 클러스터 내부) 겸용 → CloudFront로 바꾸면 실행이 깨질 위험. 그대로 둠.
- `workflow_data.base_url`(=Outputs 링크 소스)은 UI 표시용 하이퍼링크 전용임을
  실증 확정(내부 라우터로 `base_url + /<id>` 및 `/api/workflow/<id>/data`,`/download`,
  `/outputs` 전부 404, `/api/workflow/<id>`만 200; 데이터는 credential.endpoint
  s3://로만 전송; CLI에 output download 서브커맨드 없음). → base_url을 바꿔도
  다운로드/전송엔 사이드이펙트 없음. 여기까진 맞음.
- 그러나 결정적 오진: Outputs 링크 형식 `<base_url>/<workflow_id>`의 `/<workflow_id>`
  경로 자체가 OSMO UI에 존재하지 않는 라우트다. base_url을 CloudFront로 바꾸면 호스트만
  공개 도메인이 될 뿐, 로그인 상태 브라우저에서 클릭하면 여전히 404(라우트 없음).
  사용자가 `https://<cf>/aws-osmo-smoke-2`에서 404 확인(2026-08-03). 즉 config로는
  못 고치는 upstream UI 버그이며, 이전 usw2 진단("죽은 UI 라우트")이 옳았다.

적용 시도 → 롤백 (2026-08-03, use1)
- `osmo config update WORKFLOW`로 `workflow_data.base_url`을 내부 라우터 FQDN →
  `https://d6zt7c9afq74q.cloudfront.net`로 변경. 신규 워크플로우 `.outputs`가 CloudFront
  도메인으로 렌더되는 것까지는 확인했으나, 클릭 시 여전히 404(위 참조).
- 이득이 없어 라이브 config와 `deploy-osmo.sh`를 모두 내부 라우터 FQDN으로 롤백함
  (deploy-osmo.sh는 git diff 없음 = 원상복구). 현재 라이브 base_url =
  `http://osmo-internal-router.osmo.svc.cluster.local`.
- 백업: `/tmp/workflow-config-backup-*.json`.

실제 산출물 접근 (동작 확인 — 이게 정답)
- Output dir 링크 대신 Datasets 페이지 사용:
  `https://<cloudfront>/datasets/aws-osmo/<output-dataset-name>`
  - 01-data-prep → `e2e-pipeline-lerobot-dataset`
  - 03-vla-finetune → `e2e-pipeline-groot-checkpoint`
  - 02-sim-rl → `e2e-pipeline-sim-rl-artifacts`
  - 04-closeloop → `e2e-pipeline-closeloop-artifacts`
- 워크플로우의 output_dataset 이름은 `osmo workflow spec <id>`의 outputs.dataset.name
  또는 `osmo dataset list`로 확인.

부수 발견 (별건, 안전한 교정 후보 — 미적용)
- 라이브 `BACKEND default`의 `router_address`가 `wss://placeholder.cloudfront.net`로
  남아 있음. SSO 부트스트랩(`deploy-osmo-sso-bootstrap.sh` L45
  `PLACEHOLDER_HOSTNAME=placeholder.cloudfront.net`)이 남긴 값으로, 실제 CloudFront
  도메인(`wss://${OSMO_HOSTNAME}`)으로 재적용이 안 된 상태. 이건 실시간 로그 웹소켓
  붙는 주소라 공개 도메인이 맞고 콜백 겸용이 아니므로 상대적으로 안전한 교정 후보.

upstream UI 수정 조사 완료 (2026-08-03, web-ui:6.3.1 컨테이너 내부 빌드 분석)
- UI 소스는 이 레포에 없음(NVIDIA upstream). 배포 이미지 `nvcr.io/nvidia/osmo/web-ui:6.3.1`
  는 distroless Next.js standalone 빌드(`/app`, 셸 없음 → `node`로 조사).
- 링크 렌더 지점(빌드 청크 `/app/.next/server/chunks/ssr/_1-x15q6._.js`):
  Links 섹션이 `{id:"outputs", label:"Outputs", description:"Artifacts & results",
  url:a.outputs, icon:Package}`로, 백엔드가 준 `a.outputs`(=`base_url/<workflow_id>`)를
  그대로 href로 씀. `toProxiedPath`도 dataset 경로 변환도 안 거침.
- 실제 UI 라우트(`/app/.next/server/app`의 page.js): `/workflows/[name]`,
  `/datasets/[bucket]/[name]`, `/datasets/[bucket]`, `/datasets`, `/pools`,
  `/resources` 등. `/<workflow_id>` 라우트는 아예 없음 → 무조건 404 확정.
- 걸림돌: 워크플로우 API 응답(`osmo workflow query -t json`)에 output dataset의
  bucket/name이 없음(top-level 키에 outputs 문자열만; dataset 정보는 `spec`에만
  `outputs[].dataset.name = aws-osmo/e2e-pipeline-sim-rl-artifacts` 형태로 존재).
  즉 UI가 dataset 페이지로 링크하려면 (a) 백엔드가 workflow 응답에 output dataset
  (bucket/name)을 추가하거나, (b) UI가 spec을 별도 fetch해 파싱해야 함.

개선 방향(후보)
- (upstream, 정공법) 두 갈래:
  1) 백엔드 `update_output_path`(workflow.py)가 `base_url/<id>` 대신 output dataset
     경로를 알면 UI 링크 없이도 정답 URL 생성 가능하나, 지금 응답엔 dataset 정보가
     빠져 있어 백엔드 변경 필요.
  2) UI `workflow-details.tsx`가 outputs 링크를 `a.outputs` 대신 output dataset
     페이지(`/datasets/<bucket>/<name>`)로 라우팅. 단 현재 workflow 객체엔 dataset이
     없으니 spec fetch 또는 API 확장 선행 필요. 우리 배포 UI는 chart 이미지라 반영엔
     커스텀 빌드/이미지 교체가 필요(upstream 기여가 현실적).
- (문서, 즉시 가능) "Output dir 링크는 upstream 버그로 404. 산출물은 Datasets 페이지
  (`/datasets/aws-osmo/<output-dataset>`)에서 접근" 안내를 README/운영노트에 명시.
- (우리 배포, 저위험) `router_address` placeholder를 실제 CloudFront 도메인으로 교정
  (BACKEND config 수정 + deploy-osmo.sh에 설정 추가). 콜백 겸용이 아님을 재확인 후.
- 리전별 Grafana 유무에 따른 `grafana_url` 세팅 가이드 정리.

---

## 4. 다중 사용자 동시 사용 시의 격리 부재 (4.7 적용 완료, 나머지 미적용)

조사 일자: 2026-08-18. 대상 클러스터 `aws-osmo-use1-dev-repro-eks` (us-east-1).
라이브 `osmo config show` / `kubectl` 출력으로 확인.

4.7만 2026-08-18에 적용하고 `scripts/deploy-osmo.sh`에 반영했다(재배포 후에도 유지).
4.1은 적용해봤다가 되돌렸다 — 아래 사유 참고. 나머지 항목은 조사만 된 상태다.

한 줄 요약: 자원을 나누는 장치가 사실상 전부 무제한이고, 사용자끼리 서로의
데이터셋·자격증명·워크플로를 지울 수 있다.

### 4.1 사용자별 워크플로 수 상한이 비어 있음 (적용했다가 원복, 재설계 필요)

`osmo config show WORKFLOW`:

```json
"user_workflow_limits": {
  "max_num_workflows": null,
  "max_num_tasks": null,
  "jinja_sandbox_workers": 2,
  "jinja_sandbox_max_time": 0.5,
  "jinja_sandbox_memory_limit": 104857600
}
```

OSMO가 사용자별 상한을 제품 차원에서 지원하는데 두 값이 `null`(무제한)이다. 한
사람이 GPU 워크플로를 몇 개든 동시 제출할 수 있고, KAI 스케줄러가 노드를 붙일 수
있는 만큼 계속 붙는다. 교육/공유 클러스터에서 한 명이 전체 GPU를 점유하는 가장
흔한 경로. 값 두 개만 채우면 되고 `osmo config rollback`으로 되돌아간다.

집행은 확실히 된다 (2026-08-18 실측). `max_num_workflows: 2`로 두고 CPU 워크플로
3건을 연속 제출했더니 3번째가 거부됐다.

```
Server responded with status code 400
Error message: User testuser cannot submit more than 2 ongoing workflows.
```

그런데 원복했다 (2026-08-18). 이유는 두 가지다.

첫째, GPU 고갈의 실제 방어선은 이 값이 아니라 Karpenter NodePool의 vCPU 상한이다.
`deploy-karpenter.sh` 기본값이 g7e 120 vCPU / g6e 96 vCPU이므로, 워크플로를 몇 개
제출하든 동시에 뜰 수 있는 GPU 노드 수는 이미 묶여 있다.

```
g6e NodePool 96 vCPU 가 담을 수 있는 GPU 스테이지 수
  02-sim-rl / 04-closeloop  cpu 8  -> g6e.4xlarge  (16 vCPU)  -> 6개
  03-vla-finetune           cpu 16 -> g6e.8xlarge  (32 vCPU)  -> 3개
  06-cosmos-augment         cpu 30 -> g6e.12xlarge (48 vCPU)  -> 2개
```

둘째, 이 값은 GPU를 안 쓰는 워크플로까지 같이 센다. `01-data-prep`은 CPU 전용
(`cpu: 4`, GPU 미점유)인데도 카운트에 들어가므로, 낮은 상한은 GPU 경합과 무관한
정상 사용을 막는다. 게다가 워크플로 단위 카운트라 파이프라인 구조에 따라 불공평하다 —
`00-vla-chain`은 prepare/train/eval 3개 태스크를 워크플로 1개에 담아 카운트 1인데,
`nut-pouring-pipeline`은 같은 일을 6개 파일로 따로 제출해 카운트 6이 된다.

결론: 자원 격리는 워크플로 개수가 아니라 자원량으로 걸어야 하므로 4.2(KAI 큐 쿼터)에서
설계한다. 이 값을 다시 쓴다면 GPU 고갈 방어용이 아니라 폭주(수십~수백 건 제출) 차단용
으로, 정상 사용을 넘는 넉넉한 수(예: 10 이상)여야 한다.

원복 방법 주의: 깊은 병합이라 `{"user_workflow_limits":{"max_num_workflows":null}}`을
보내면 "No changes were made to the config."가 나오고 값이 지워지지 않는다. `null`은
"이 키는 건드리지 말라"로 해석된다. `osmo config rollback WORKFLOW:6`으로 되돌렸다.

`max_num_tasks`도 계속 `null`이다.

### 4.2 KAI 큐 쿼터가 전부 무제한

```
osmo-default-osmo-workflows        cpu/gpu/memory : quota -1, limit -1
osmo-pool-osmo-workflows-default   cpu/gpu/memory : quota -1, limit -1
```

`-1`은 무제한. 사용자 간 자원 격리가 이 계층에 없다. 단 `overQuotaWeight`가 이미
`1`이라 나중에 사람별 쿼터를 나눠도 남는 GPU는 초과 사용으로 흘러가므로, 격리를
넣어도 자원이 노는 낭비는 생기지 않는다.

### 4.3 네임스페이스 쿼터가 없음

```
kubectl get resourcequota,limitrange -n osmo-workflows
  No resources found in osmo-workflows namespace.
```

Kubernetes 계층의 안전망도 없다. 4.2와 함께 설계해야 한다.

### 4.4 GPU 검증 규칙 자체가 없음

`osmo config show RESOURCE_VALIDATION`에 정의된 규칙은 `default_cpu`,
`default_memory`, `default_storage` 세 개뿐이고 GPU 규칙이 없다. 풀 설정도 마찬가지:

```
POOL default:
  resources: { "gpu": null }
  common_resource_validations: [default_cpu, default_memory, default_storage]
```

사용자가 GPU 개수를 비상식적으로 크게 잡아 제출해도 검증에서 걸러지지 않는다.
`osmo pool list`에서도 GPU `Quota Limit` = 0, `Total Capacity` = 0.

### 4.5 남의 데이터셋과 공유 자격증명을 지울 수 있음

`osmo config show ROLE`의 `osmo-user`:

```
Allow | [app:*, auth:Token, credentials:*, dataset:*, pool:List,
          profile:Read, profile:Update, resources:Read, user:List,
          workflow:List, workflow:Read] | on: [*]
Allow | [workflow:*] | on: [pool/default]
```

`dataset:*`의 대상이 `*`다. 데이터셋에는 `Created By` 표시만 있고 접근 제어가 없어
누구나 남의 학습 결과물을 삭제할 수 있다(예: `e2e-vla-chain-groot-checkpoint`
60.7 GiB, `e2e-pipeline-groot-checkpoint` 30.3 GiB). `credentials:*`도 대상이
`*`이므로 한 사람이 자기 Hugging Face 토큰으로 공유 `huggingface_token`을 덮어쓰면
다른 사람 워크플로가 전부 깨진다.

### 4.6 남의 학습을 취소할 수 있음

`workflow:*`의 대상이 `pool/default`이고 이 클러스터에는 풀이 `default` 하나뿐이다.
`workflow:*`에는 Cancel과 Delete가 포함되고 정책에 소유자 조건이 없다.
`osmo workflow list`에 `User` 컬럼이 있어 소유자는 기록되지만, 그건 표시일 뿐
권한 경계가 아니다. 실제 교차 취소 가능 여부는 사용자가 두 명 이상이어야 실측되며
현재는 전부 `testuser`라 미검증.

4.5/4.6은 OSMO RBAC이 소유자 범위 조건(owner-scoped condition)을 표현할 수 있는지
조사가 선행돼야 한다. 가능하면 정책 한 줄 수정, 불가하면 사용자별 풀 구성이라는
큰 작업이 된다.

### 4.7 타임아웃이 전부 60일이고 기본값 == 최대값 (적용 완료)

```
POOL default:
  default_exec_timeout : 60d
  max_exec_timeout     : 60d
  default_queue_timeout: 60d
  max_queue_timeout    : 60d
```

GPU 파드 템플릿(`aws-g7e-rtx-pro-6000`)에 `karpenter.sh/do-not-disrupt: "true"`가
붙어 있어 Karpenter가 노드를 회수하지 못한다. 장시간 학습 보호로는 맞지만, 잘못된
워크플로 하나가 GPU 노드를 최대 60일 점유해도 막을 수단이 없다는 뜻이다.
`max_exec_timeout`이 기본값과 같아 사용자가 상한을 낮출 동기도 없다.

적용 (2026-08-18):

```
default_exec_timeout : 6h
max_exec_timeout     : 7d
default_queue_timeout: 1h
max_queue_timeout    : 2d
```

원래 후보값이던 `max_exec_timeout: 24h`는 쓰지 않았다. 리포 전체 워크플로의
`exec_timeout` 최대값이 이를 넘기 때문이다.

```
168h  examples/nut-pouring-pipeline/workflows/05_lerobot_conversion.yaml:23
 7d   examples/nut-pouring-pipeline/workflows/01_mimic_generation.yaml
 7d   examples/nut-pouring-pipeline/workflows/06_groot_finetune.yaml
 3d   examples/nut-pouring-pipeline/workflows/03_cosmos_augmentation.yaml
 3d   e2e-pipeline-examples/06-cosmos-augment/workflow.yaml   <- 워크샵 스테이지
```

`queue_timeout` 최대값은 같은 `05_lerobot_conversion.yaml:24`의 `48h`다. 그래서
상한을 `7d`/`2d`로 잡아 기존 워크플로 어느 것도 걸리지 않게 했다.

주의 — 이 버전에서 `max_*`는 제출 시 집행되지 않는다. 상한을 넘는 값
(`exec_timeout: 200h` / `queue_timeout: 72h`)으로 CPU 워크플로를 제출했더니
`osmo workflow validate`와 `submit`이 모두 통과했고, `osmo workflow spec`에
요청값(`8d8h` / `3d`)이 그대로 저장됐다. 클램프(자동 하향)도 없었다. 상한값은
장래 버전에서 집행이 켜질 때를 대비한 것이며, 지금 실효가 있는 건
`default_*`(YAML에 `timeout` 블록이 없는 워크플로에 적용)뿐이다.

`scripts/deploy-osmo.sh`에 read-modify-write 방식으로 넣었고 GPU 플랫폼 설정보다
앞에서 실행된다. `OSMO_POOL_DEFAULT_EXEC_TIMEOUT` / `OSMO_POOL_MAX_EXEC_TIMEOUT` /
`OSMO_POOL_DEFAULT_QUEUE_TIMEOUT` / `OSMO_POOL_MAX_QUEUE_TIMEOUT`로 덮어쓴다.

### 4.8 토큰 수명 365일

`max_token_duration: 365d`. 현재 발급된 토큰은 없다. 사람이 늘면 각자 CLI 토큰을
만들 텐데 회수 절차가 없으면 1년짜리 유효 자격증명이 방치된다.

### 4.9 노드 임시 스토리지 압박 (실제 발생)

테스트 워크플로 첫 시도가 죽었다.

```
Evicted: The node was low on resource: ephemeral-storage.
Threshold: 2139512454, available: 1654612Ki
```

노드 3대 중 1대만 `DiskPressure=True`:

| 노드 | DiskPressure | 할당가능 임시스토리지 |
|---|---|---|
| `ip-10-40-18-116` | False | 약 18GB |
| `ip-10-40-4-9` | False | 약 18GB |
| `ip-10-40-5-232` | True | 여유 1.6GB |

재제출하니 다른 노드에 배치돼 정상 실행됐다. 즉 지금도 스케줄 운에 따라 죽는다.
쿼터 문제가 아니라 노드 디스크 관리 문제이므로 별도 조사가 필요하다.

### 4.10 사용자마다 WAF 허용목록에 IP를 넣어야 함

의도된 설계이지만 잊기 쉬운 단계다. 여기 없는 IP는 로그인 화면에 도달하기 전에
차단된다. `scripts/add-osmo-user.sh`가 이 경고를 출력한다.

주의: `infra/cloudfront`에 tfvars가 여러 개 있고, use1 배포에 적용되는 파일은
`terraform.use1.tfvars`(항목 2개)다. `terraform.tfvars`에는 적용된 적 없는 서울
리전 값이 남아 있어 허용목록을 오독하기 쉽다.

### 전역 상한은 걸려 있음

반대로 잘 설정된 값들:

| 항목 | 값 |
|---|---|
| `max_num_tasks` | 20 |
| `max_num_ports_per_task` | 30 |
| `max_retry_per_job` | 5 |
| `max_log_lines` | 10000 |
| `force_cleanup_delay` | 1h |

문제는 전부 전역이라는 점이다. 워크플로 하나당 태스크 20개는 막지만, 사용자 한 명이
워크플로 몇 개까지인지는 `null`이라 안 막는다.

### 권하는 순서

1. 4.7 — 완료(2026-08-18). 순수 설정값 변경(`osmo config update`)이라 파드 재시작이나
   실행 중 워크플로 중단이 없었다. `osmo config rollback`으로 되돌아간다.
2. 4.2 + 4.3 + 4.4 — 이제 여기가 최우선이다. 4.7의 `max_*`는 집행되지 않고, 4.1의
   워크플로 개수 상한은 자원량과 무관해 원복했으므로, 실질적인 자원 격리는 KAI 큐
   쿼터 계층밖에 남지 않는다. 쿼터와 GPU 검증은 함께 설계해야 한다.
3. 4.5 + 4.6 — RBAC 소유자 범위 표현 가능성 조사 선행.
4. 4.9 — 별도 조사.

---

## 5. kubectl port-forward가 큰 workflow submit에서 리셋됨 (운영 노트)

증상
- `osmo workflow submit`을 `kubectl -n osmo port-forward svc/osmo-internal-router
  9100:80` 경유로 보낼 때, payload가 크면(예: 23KB 04-closeloop) "Connection
  reset by peer" / "error creating error stream for port 9100 -> 8080: Timeout
  occurred"로 실패한다. 작은 payload(예: 14KB PoC)나 `osmo workflow list`는 성공.

배경 / 원인
- kubectl port-forward(SPDY)가 큰 요청 body에서 error-stream 생성에 타임아웃.
  port-forward를 새로 띄운 직후에는 첫 대형 요청이 통과하지만, 시간이 지나면
  타임아웃이 누적돼 재시도가 계속 리셋된다.
- OSMO CLI 엔드포인트는 `~/.config/osmo/login.yaml`에서 `http://127.0.0.1:9100`
  으로 고정 → port-forward가 유일한 진입점인 로컬 개발 환경 특유의 문제.

워크어라운드 (검증됨 2026-08-03)
- 대형 submit 직전에 port-forward를 새로 재시작하면 첫 요청이 통과한다.
- 근본 해결 후보: gateway를 ALB/CloudFront 공개 엔드포인트로 접근하도록 CLI url
  변경, 또는 클러스터 내부 pod에서 submit, 또는 port-forward 대신 `kubectl exec`.
