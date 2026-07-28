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

이후 `deploy-osmo.sh`가 `admin_user_sub` 출력값을 읽어 해당 Cognito subject에 OSMO의 `osmo-admin` 역할을 부여하므로, 최초 SSO 로그인 시 이미 전체 관리자 권한을 갖습니다 — 이후 수동으로 `osmo user update`를 실행할 필요가 없습니다. `osmo-admin` 이외의 역할을 원한다면 `OSMO_SSO_ADMIN_ROLES`로 재정의하세요.

추후 사용자를 추가하거나 Terraform 관리 사용자를 건너뛰려면(`admin_email = ""`), 관리자 API를 직접 사용하세요:

```bash
POOL=$(terraform output -raw user_pool_id)
aws cognito-idp admin-create-user \
  --user-pool-id "$POOL" \
  --username user@example.com \
  --user-attributes Name=email,Value=user@example.com Name=email_verified,Value=true \
  --message-action SUPPRESS
aws cognito-idp admin-set-user-password \
  --user-pool-id "$POOL" \
  --username user@example.com \
  --password 'ChangeMe1!' --permanent
```

Terraform 외부에서 프로비저닝된 새 사용자는 최초 로그인 시 `osmo-default` 역할만 부여됩니다. 역할을 추가하려면 `osmo user update <cognito-sub> --add-roles osmo-admin`을 사용하세요.

## 출력값

| 출력값 | 설명 |
|--------|-------------|
| `user_pool_id` | Cognito 사용자 풀 ID |
| `hosted_ui_url` | Cognito hosted 로그인 UI의 기본 URL |
| `oidc_issuer_url` | `gateway.oauth2Proxy.oidcIssuerUrl`용 OIDC issuer |
| `client_id` | `gateway.oauth2Proxy.clientId`용 앱 클라이언트 ID |
| `client_secret` | `oauth2-proxy-secrets` K8s secret용 앱 클라이언트 시크릿 (민감 정보) |
| `admin_user_sub` | 최초 로그인 사용자의 Cognito subject; `deploy-osmo.sh`에 의해 `osmo-admin` 역할이 부여되는 OSMO 사용자 ID |
| `admin_user_email` | 최초 로그인 사용자의 이메일/사용자명 |
