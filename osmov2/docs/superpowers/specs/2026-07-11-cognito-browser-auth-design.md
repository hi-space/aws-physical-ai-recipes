# 설계: ALB 네이티브 Cognito 브라우저 인증 (osmov2)

> 작성일: 2026-07-11
> 대상: `/home/ubuntu/workspace/aws-physical-ai-recipes/osmov2`
> 참고: `/home/ubuntu/workspace/sample-aws-physical-ai-toolchain` (toolchain)
> 관련 문서: [comparison-with-toolchain.md](../../comparison-with-toolchain.md)

## 배경 & 목표

osmov2는 현재 OSMO Web UI/API를 인증 없이 노출한다(모든 서비스 ClusterIP, 기본은 `kubectl port-forward` 접근, 선택적 `infra/ingress` ALB는 인증 없는 공개 HTTPS). toolchain을 참고하여 **브라우저 UI를 AWS Cognito 로그인으로 보호**한다.

**범위 (이번 작업):**
- OSMO Web UI에 대한 브라우저 기반 Cognito 로그인(OIDC Authorization Code)
- **ALB 네이티브 인증**(`authenticate-cognito`) 계층에서 처리 — 사이드카/Redis 세션 스토어 없음

**범위 밖 (명시적 제외, YAGNI):**
- CLI/device flow 인증 → 기존 admin/backend 토큰 방식 유지, 향후 확장
- Keycloak, Identity Center → 사용 안 함
- OSMO 앱 내부의 세밀한 RBAC 인가 로직 → 그룹 정의만 남기고 인가는 미구현
- OSMO 차트의 비활성 사이드카(`oauth2Proxy/envoy/authz: enabled:false`) → 원저자 방어값, 건드리지 않음

## 왜 ALB 네이티브인가 (설계 결정 근거)

브라우저 Cognito 인증 방식 두 가지 중:

- **패턴 A — ALB 네이티브 `authenticate-cognito`** ✅ 채택
  - AWS 공식 권장, 추가 컴포넌트 없음(사이드카/Redis 불필요)
  - osmov2의 `infra/ingress`가 이미 ALB + ACM + Route53 프로비저닝 → 리스너 인증 액션만 추가
  - "관리형 서비스 우선, 단순·재현성" osmov2 철학과 정합
- **패턴 B — Envoy + oauth2-proxy 사이드카** ❌ 미채택
  - 운영 복잡도 큼(Redis 세션, 쿠키 시크릿, 사이드카 2개)
  - toolchain에서도 이 경로는 Keycloak 전용이며 Cognito는 미검증(참고 정답 코드 없음)

**전제:** ALB Cognito 인증은 HTTPS 리스너에서만 동작하고 공개 콜백 URL이 필요하므로, 이 기능은 `infra/ingress` 모듈과 한 몸으로 동작한다. ingress를 배포하지 않으면 인증도 없다(기존 port-forward 개발 흐름 보존).

## 아키텍처

```
브라우저
  → ALB HTTPS 리스너 (infra/ingress, ACM cert)
      └ 미인증 → Cognito Hosted UI 로그인 리다이렉트
      └ 로그인 후 /oauth2/idpresponse 콜백 → ALB가 세션 쿠키(AWSELBAuthSessionCookie) 발급
      └ forward → osmo-ui:80  (ALB가 X-Amzn-Oidc-* 헤더로 사용자 클레임 전달)
  → osmo-ui pod
```

앱 코드/OSMO 차트 변경 없음. 인증은 전적으로 ALB ↔ Cognito 간에 처리된다.

## 컴포넌트 변경

### 1. Terraform: Cognito 리소스 (`infra/ingress/`에 추가)

Cognito는 브라우저 인증 = ingress와 한 몸이므로 별도 모듈이 아닌 `infra/ingress`에 둔다(ingress 미배포 시 Cognito도 안 생김). toolchain의 `modules/platform/cognito.tf`를 osmov2 스타일로 참고 이식.

신규 리소스:
- `aws_cognito_user_pool` — 이메일 로그인, 비밀번호 정책, `preferred_username` 속성
- `aws_cognito_user_pool_client.browser` — Authorization Code + `generate_secret = true`, scope `openid email profile`, callback `https://<domain_name>/oauth2/idpresponse`, logout URL, refresh token auth
- `aws_cognito_user_pool_domain` — **Cognito 접두사 도메인**(`<prefix>.auth.<region>.amazoncognito.com`) 사용. us-east-1 ACM·placeholder A레코드 불필요(toolchain 커스텀 도메인 방식은 과함, 미채택)
- `aws_cognito_user_group.admin` (`osmo-admin`) / `aws_cognito_user_group.user` (`osmo-user`) — 그룹 정의만(향후 RBAC 포섭용, 인가 로직 없음)
- (선택) `aws_cognito_user.admin` + `aws_cognito_user_in_group.admin` — `cognito_admin_email` 제공 시 초기 관리자 생성

신규 변수 (`infra/ingress/variables.tf`):
- `enable_cognito_auth` (bool, default `true`)
- `cognito_domain_prefix` (string) — Hosted UI 접두사
- `cognito_admin_email` (string, default `""` — 비면 관리자 미생성)
- `cognito_admin_temp_password` (string, sensitive, default 제공)

신규 출력 (`infra/ingress/outputs.tf`):
- `cognito_user_pool_arn`, `cognito_browser_client_id`, `cognito_user_pool_domain`, `cognito_issuer`
- `cognito_browser_client_secret` (sensitive) — 참고용. **ALB annotation에는 secret이 아니라 pool ARN/client ID/domain만 필요**(secret은 ALB↔Cognito 간 자동 처리)

### 2. ALB Ingress annotation (`infra/ingress/main.tf`의 `kubernetes_ingress_v1.osmo_admin`)

`enable_cognito_auth`가 true일 때 다음 annotation을 추가(AWS Load Balancer Controller):

```yaml
alb.ingress.kubernetes.io/auth-type: cognito
alb.ingress.kubernetes.io/auth-idp-cognito: |
  {"userPoolARN":"<pool_arn>","userPoolClientID":"<client_id>","userPoolDomain":"<domain_prefix>"}
alb.ingress.kubernetes.io/auth-scope: "openid email profile"
alb.ingress.kubernetes.io/auth-session-timeout: "3600"
alb.ingress.kubernetes.io/auth-on-unauthenticated-request: authenticate
```

민감정보(client secret)는 annotation에 넣지 않는다 — ALB가 Cognito와 직접 처리.

### 3. catch-all 규칙 조건부 제거

현재 Ingress에는 규칙이 2개:
- 규칙 1 (host = `domain_name`) — 정상 도메인 접근
- 규칙 2 (host 없는 catch-all) — raw ALB DNS 데모 접근용

ALB Cognito 인증은 Ingress 전체에 적용되고 콜백 호스트는 `domain_name`에 고정되므로, raw ALB DNS 접근은 OAuth 콜백 호스트 불일치로 로그인이 깨진다.

**결정:** `enable_cognito_auth`가 true이면 host 없는 catch-all 규칙(규칙 2)을 제거하여 도메인 전용으로 만든다. false이면 기존대로 catch-all 유지.

### 4. 의존성 순서

같은 `terraform apply` 안에서 참조로 해결:
1. Cognito User Pool / client / domain 생성
2. client callback URL = `https://<domain_name>/oauth2/idpresponse`
3. Ingress annotation에 pool ARN/client ID/domain 주입

## 문서화

- `docs/security.md`: Cognito 브라우저 인증 섹션 추가(활성화 방법, 접근은 반드시 도메인 경유, CLI는 토큰 유지)
- `infra/ingress/README.md`: `enable_cognito_auth` 변수, 초기 관리자 설정, 첫 로그인(임시 비밀번호 변경) 안내
- `terraform.tfvars.example`: 신규 변수 예시

## 재현성/검증

- osmov2 패턴대로 배포 후 검증 기록 남김: ingress + Cognito 활성 → 도메인 접근 시 Cognito Hosted UI 리다이렉트 → 로그인 → osmo-ui 표시 확인
- `enable_cognito_auth=false`로 기존 동작(인증 없는 ALB, port-forward) 회귀 없음 확인

## 범위 밖 / 향후 작업

- CLI(device flow) Cognito 인증
- Cognito 그룹 클레임(`X-Amzn-Oidc-Data`) 기반 앱 레벨 RBAC
- toolchain의 다른 기능(WAF, GuardDuty, Fluent Bit 로깅, 배포 모드) — 별도 작업
