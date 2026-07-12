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

## Create a login user

```bash
POOL=$(terraform output -raw user_pool_id)
aws cognito-idp admin-create-user \
  --user-pool-id "$POOL" \
  --username admin@example.com \
  --user-attributes Name=email,Value=admin@example.com Name=email_verified,Value=true \
  --message-action SUPPRESS
aws cognito-idp admin-set-user-password \
  --user-pool-id "$POOL" \
  --username admin@example.com \
  --password 'ChangeMe1!' --permanent
```

## Outputs

| Output | Description |
|--------|-------------|
| `user_pool_id` | Cognito user pool ID |
| `hosted_ui_url` | Base URL of the Cognito hosted login UI |
| `oidc_issuer_url` | OIDC issuer for `gateway.oauth2Proxy.oidcIssuerUrl` |
| `client_id` | App client ID for `gateway.oauth2Proxy.clientId` |
| `client_secret` | App client secret (sensitive) for the `oauth2-proxy-secrets` K8s secret |
