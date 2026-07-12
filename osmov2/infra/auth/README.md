# infra/auth — OSMO IdP (Cognito / IAM Identity Center)

Opt-in, reference-ha 전용. 기본 dev-repro 배포는 인증 없이 동작한다.

## Cognito (권장)

```hcl
deploy_cognito = true
name_prefix    = "aws-osmo-reference-ha"
aws_region     = "ap-northeast-2"
osmo_hostname  = "osmo.example.com"   # ALB FQDN (deploy-ingress와 동일)
```

`terraform apply` 후 `deploy-auth.sh` → `deploy-ingress` → `deploy-osmo.sh`(OSMO_AUTH_ENABLED=true) 순으로 진행.

## IAM Identity Center

```hcl
deploy_identity_center = true
name_prefix            = "aws-osmo-reference-ha"
osmo_auth_hostname     = "osmo-auth.example.com"
```

**수동 단계 (필수)**: `terraform apply` 후 IAM Identity Center 콘솔 →
생성된 `*-osmo` 애플리케이션 → OAuth 2.0 설정에서:
1. authorization_code grant + redirect URI `https://<osmo_hostname>/oauth2/callback` 추가
2. scope `openid email profile` 부여
3. **client_secret 생성** 후 값을 안전하게 보관 → `deploy-osmo.sh`에
   `OSMO_OIDC_CLIENT_SECRET` 환경변수로 전달.
