# Cognito SSO for OSMO Admin UI

Amazon Cognito user pool that fronts the OSMO Admin UI login with OIDC single sign-on. The OSMO gateway's oauth2-proxy delegates authentication to the Cognito hosted UI.

## Architecture

```
User -> CloudFront (HTTPS) -> ALB -> OSMO gateway (envoy)
                                        -> oauth2-proxy (OIDC)
                                            -> Cognito hosted UI (login)
```

Unauthenticated requests are redirected by oauth2-proxy to the Cognito hosted UI. After login, Cognito calls back to `https://<ui_hostname>/oauth2/callback` and oauth2-proxy establishes the session.

## Prerequisites

- OSMO UI reachable via a CloudFront domain (see `infra/cloudfront`). The callback and logout URLs are pinned to that hostname.

## Deploy

```bash
cd infra/cognito
cp terraform.tfvars.example terraform.tfvars
# Set ui_hostname to the infra/cloudfront output `osmo_ui_cloudfront_domain`
terraform init
terraform apply
```

## Wire into the OSMO gateway

Feed the Terraform outputs into the `osmo-service` Helm values (`gateway.oauth2Proxy`) and the `oauth2-proxy-secrets` K8s secret:

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

## Initial login user

Self-registration is disabled (`allow_admin_create_user_only = true`), so the
pool needs at least one admin-created user. Set `admin_email` and
`admin_password` in the tfvars and Terraform provisions the user with a
permanent password (no temp-password email), so the deploy is non-interactive:

```hcl
admin_email    = "admin@example.com"
admin_password = "<choose-a-strong-password>"
```

`deploy-osmo.sh` then reads the `admin_user_sub` output and grants that Cognito
subject the `osmo-admin` role in OSMO, so the very first SSO login already has
full admin access — no manual `osmo user update` afterwards. Override the roles
with `OSMO_SSO_ADMIN_ROLES` if you want something other than `osmo-admin`.

### Where an admin creates additional users

Self-registration is off, so there is no "Sign up" button on the hosted UI, and
the OSMO Admin UI itself has no user-management screen. An admin adds users in
one of two places: the Cognito console or the AWS CLI. Both target the same user
pool (`terraform output -raw user_pool_id`).

Cognito console (GUI):

```
Cognito console -> User pools -> <user_pool_id> -> Users tab -> "Create user"
# https://<region>.console.aws.amazon.com/cognito/v2/idp/user-pools/<user_pool_id>/users
```

AWS CLI, permanent password (user logs in with it directly, no forced change):

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

AWS CLI, temporary-password onboarding (user sets their own password on first
login — the user lands in `FORCE_CHANGE_PASSWORD` and the hosted UI prompts for
a new password):

```bash
aws cognito-idp admin-create-user \
  --user-pool-id "$POOL" \
  --username user@example.com \
  --user-attributes Name=email,Value=user@example.com Name=email_verified,Value=true \
  --temporary-password 'TempPass123!'
# omit --message-action SUPPRESS to email the invite (Cognito default sender is
# capped at ~50/day unless the pool is wired to SES)
```

New users provisioned outside Terraform are auto-created in OSMO with only
`osmo-default` on first login; grant them roles with
`osmo user update <cognito-sub> --add-roles osmo-admin`.

Note: creating a Cognito user only grants login. To actually reach the OSMO UI
in a browser, the user's source IP must be in the CloudFront WAF allowlist
(`allowed_cidrs` in `infra/cloudfront`); otherwise the request is blocked before
it reaches the login page.

## Outputs

| Output | Description |
|--------|-------------|
| `user_pool_id` | Cognito user pool ID |
| `hosted_ui_url` | Base URL of the Cognito hosted login UI |
| `oidc_issuer_url` | OIDC issuer for `gateway.oauth2Proxy.oidcIssuerUrl` |
| `client_id` | App client ID for `gateway.oauth2Proxy.clientId` |
| `client_secret` | App client secret (sensitive) for the `oauth2-proxy-secrets` K8s secret |
| `admin_user_sub` | Cognito subject of the initial login user; OSMO user id granted `osmo-admin` by `deploy-osmo.sh` |
| `admin_user_email` | Email/username of the initial login user |
