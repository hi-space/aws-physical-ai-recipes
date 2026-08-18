# Cognito SSO for OSMO Admin UI

> 이 문서는 [README.md](README.md)(영문)의 한국어 번역본입니다.

OSMO Admin UI 로그인에 OIDC 단일 로그인을 적용하는 Amazon Cognito 사용자 풀입니다. OSMO gateway의 oauth2-proxy가 Cognito hosted UI에 인증을 위임합니다.

## 아키텍처

```
User -> CloudFront (HTTPS) -> ALB -> OSMO gateway (envoy)
                                        -> oauth2-proxy (OIDC)
                                            -> Cognito hosted UI (login)
```

인증되지 않은 요청은 oauth2-proxy에 의해 Cognito hosted UI로 리다이렉트됩니다. 로그인 후 Cognito는 `https://<ui_hostname>/oauth2/callback`으로 콜백을 전송하고 oauth2-proxy가 세션을 수립합니다.

## 사전 조건

- CloudFront 도메인을 통해 OSMO UI에 접근 가능해야 합니다 (`infra/cloudfront` 참조). 콜백 및 로그아웃 URL은 해당 호스트명에 고정됩니다.

## 배포

```bash
cd infra/cognito
cp terraform.tfvars.example terraform.tfvars
# Set ui_hostname to the infra/cloudfront output `osmo_ui_cloudfront_domain`
terraform init
terraform apply
```

## OSMO gateway 연결

Terraform 출력값을 `osmo-service` Helm values(`gateway.oauth2Proxy`)와 `oauth2-proxy-secrets` K8s secret에 반영합니다:

```bash
terraform output -raw client_id          # -> gateway.oauth2Proxy.clientId
terraform output -raw oidc_issuer_url     # -> gateway.oauth2Proxy.oidcIssuerUrl
terraform output -raw client_secret       # -> oauth2-proxy-secrets / client_secret

# Create/refresh the K8s secret consumed by oauth2-proxy
kubectl create secret generic oauth2-proxy-secrets -n osmo \
  --from-literal=client_secret="$(terraform output -raw client_secret)" \
  --from-literal=cookie_secret="$(openssl rand -base64 32 | tr -- '+/' '-_')" \
  --dry-run=client -o yaml | kubectl apply -f -
```

## 최초 로그인 사용자

자가 등록은 비활성화(`allow_admin_create_user_only = true`)되어 있으므로, 풀에는 관리자가 직접 생성한 사용자가 최소 한 명 있어야 합니다. tfvars에 `admin_email`과 `admin_password`를 설정하면 Terraform이 임시 비밀번호 이메일 없이 영구 비밀번호로 사용자를 프로비저닝하므로 배포가 비대화형으로 진행됩니다:

```hcl
admin_email    = "admin@example.com"
admin_password = "<choose-a-strong-password>"
```

이후 `deploy-osmo.sh`가 `admin_user_name` 출력값(`preferred_username`, 즉 이메일 로컬 파트)을 읽어 해당 OSMO 사용자에 `osmo-admin` 역할을 부여하므로, 최초 SSO 로그인 시 이미 전체 관리자 권한을 갖습니다 — 이후 수동으로 `osmo user update`를 실행할 필요가 없습니다. `osmo-admin` 이외의 역할을 원한다면 `OSMO_SSO_ADMIN_ROLES`로 재정의하세요.

### 관리자가 추가 사용자를 생성하는 위치

자가 등록이 꺼져 있어 hosted UI에 "Sign up" 버튼이 없고, OSMO Admin UI 자체에도
사용자 관리 화면이 없습니다. 사용자는 관리자가 추가해야 합니다.

권장 경로는 `scripts/add-osmo-user.sh`입니다. 필요한 두 단계(Cognito 계정 생성 +
OSMO 역할 부여)를 모두 처리하고 `preferred_username`도 항상 채웁니다:

```bash
scripts/add-osmo-user.sh user@example.com                      # osmo-user (기본값)
scripts/add-osmo-user.sh lead@example.com --roles osmo-admin   # 전체 관리자
scripts/add-osmo-user.sh user@example.com --temporary          # 사용자가 첫 로그인 시 직접 비밀번호 설정
```

아래 수동 명령은 참고용이거나, Cognito 계정만 만들고 싶을 때 쓰세요. 둘 다 동일한
사용자 풀(`terraform output -raw user_pool_id`)을 대상으로 합니다.

Cognito 콘솔 (GUI):

```
Cognito 콘솔 -> User pools -> <user_pool_id> -> Users 탭 -> "Create user"
# https://<region>.console.aws.amazon.com/cognito/v2/idp/user-pools/<user_pool_id>/users
```

AWS CLI, 영구 비밀번호 (사용자가 바로 이 비번으로 로그인, 강제 변경 없음):

```bash
POOL=$(terraform output -raw user_pool_id)
aws cognito-idp admin-create-user \
  --user-pool-id "$POOL" \
  --username user@example.com \
  --user-attributes Name=email,Value=user@example.com Name=email_verified,Value=true \
                    Name=preferred_username,Value=user \
  --message-action SUPPRESS
aws cognito-idp admin-set-user-password \
  --user-pool-id "$POOL" \
  --username user@example.com \
  --password 'ChangeMe1!' --permanent
```

`preferred_username`을 빼먹지 마세요. 이 값이 없으면 oauth2-proxy가 Cognito `sub`로
대체하므로 웹 UI에 UUID가 표시되고 "내 워크플로" 필터가 아무것도 못 찾습니다.

AWS CLI, 임시 비밀번호 온보딩 (사용자가 첫 로그인 시 본인 비번을 직접 설정 —
사용자는 `FORCE_CHANGE_PASSWORD` 상태가 되고 hosted UI가 새 비번을 요구):

```bash
aws cognito-idp admin-create-user \
  --user-pool-id "$POOL" \
  --username user@example.com \
  --user-attributes Name=email,Value=user@example.com Name=email_verified,Value=true \
                    Name=preferred_username,Value=user \
  --temporary-password 'TempPass123!'
# --message-action SUPPRESS 를 빼면 초대 이메일이 발송됨 (Cognito 기본 발신자는
# SES 연동 전에는 하루 ~50건으로 제한)
```

Cognito 계정만으로는 부족합니다. 최초 로그인 시 `idp-sync`가 OSMO 사용자를 자동
생성하지만 역할은 `osmo-default` 하나뿐이라 로그인과 프로필 조회만 되고 워크플로
제출은 안 됩니다. 따라서 `preferred_username` 기준으로 역할을 직접 부여해야 합니다:

```bash
NAME=$(aws cognito-idp admin-get-user --user-pool-id "$POOL" \
  --username user@example.com \
  --query 'UserAttributes[?Name==`preferred_username`].Value' --output text)
osmo user create "$NAME" --roles osmo-user            # 첫 로그인 전
osmo user update "$NAME" --add-roles osmo-user        # idp-sync가 이미 만들었으면
```

역할은 반드시 `preferred_username`에 걸어야 합니다(게이트웨이의 `user_claim`과
일치). `sub`가 아닌 이유는 웹 UI의 "내 워크플로" 필터가 oauth2-proxy의
`x-auth-request-preferred-username` 헤더와 비교하기 때문입니다 — `sub`로 걸면
소유자가 필터에 절대 잡히지 않는 UUID가 됩니다. 서비스 차트의
`external_roles` 필드는 이 배포에서 IdP 그룹을 OSMO 역할로 매핑해주지 않습니다 —
게이트웨이의 역할 필터가 읽는 `roles` JWT 클레임을 Cognito ID 토큰이 담고 있지 않기
때문이며, 그래서 역할은 OSMO 데이터베이스에서만 옵니다. 회원가입을 허용해도 이 수동
단계가 없어지지 않는 이유입니다.

참고: Cognito 사용자를 만드는 것은 로그인 권한만 부여합니다. 실제로 브라우저에서
OSMO UI에 접근하려면 사용자의 출발 IP가 CloudFront WAF allowlist
(`infra/cloudfront`의 `allowed_cidrs`)에 있어야 합니다. 그렇지 않으면 요청이 로그인
페이지에 도달하기 전에 차단됩니다.

## 출력값

| 출력값 | 설명 |
|--------|-------------|
| `user_pool_id` | Cognito 사용자 풀 ID |
| `hosted_ui_url` | Cognito hosted 로그인 UI의 기본 URL |
| `oidc_issuer_url` | `gateway.oauth2Proxy.oidcIssuerUrl`용 OIDC issuer |
| `client_id` | `gateway.oauth2Proxy.clientId`용 앱 클라이언트 ID |
| `client_secret` | `oauth2-proxy-secrets` K8s secret용 앱 클라이언트 시크릿 (민감 정보) |
| `admin_user_name` | 최초 로그인 사용자의 `preferred_username`; `deploy-osmo.sh`에 의해 `osmo-admin` 역할이 부여되는 OSMO 사용자 ID |
| `admin_user_sub` | 최초 로그인 사용자의 Cognito subject; 풀 내 안정적 식별자이지만 더 이상 OSMO 사용자 ID는 아님 |
| `admin_user_email` | 최초 로그인 사용자의 이메일/사용자명 |
