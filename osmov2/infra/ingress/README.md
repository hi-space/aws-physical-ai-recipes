# OSMO Admin Ingress

This optional Terraform root exposes the OSMO Web UI through HTTPS using AWS Load Balancer Controller, ACM, Route 53, and an ALB-backed Kubernetes Ingress.

The baseline deployment remains private. Only apply this root when an administrator domain and a restricted source CIDR allow list are available.

```bash
cp infra/ingress/terraform.tfvars.example infra/ingress/terraform.tfvars

terraform -chdir=infra/core output -raw cluster_name
terraform -chdir=infra/core output -raw cluster_oidc_issuer_url
terraform -chdir=infra/core output -raw cluster_oidc_provider_arn
terraform -chdir=infra/core output -raw vpc_id

terraform -chdir=infra/ingress init
terraform -chdir=infra/ingress apply
```

Required inputs:

- `domain_name`: fully qualified admin UI hostname, for example `osmo.example.com`.
- `hosted_zone_id`: Route 53 hosted zone that owns the hostname.
- `allowed_cidrs`: trusted administrator CIDRs. `0.0.0.0/0` is rejected.

The Ingress routes only to the private `osmo-ui` service. The UI deployment proxies API calls to `osmo-service` inside the cluster, so the public ALB does not need to expose the API service separately.

## Cognito Browser Authentication (optional)

Set `enable_cognito_auth = true` to require AWS Cognito login before the admin
UI is served. The ALB performs the OIDC Authorization Code handshake itself
(`authenticate-cognito`); no in-cluster proxy or Redis session store is added.

Additional inputs:

- `cognito_domain_prefix` (required when enabled): globally unique Hosted UI
  prefix, resolving to `<prefix>.auth.<region>.amazoncognito.com`.
- `cognito_admin_email` (optional): creates an initial admin user in the
  `osmo-admin` group.
- `cognito_admin_temp_password` (optional): temporary password for that user;
  Cognito forces a change on first login.

When enabled, access is domain-only: the host-less catch-all rule is removed so
the OAuth callback (`https://<domain_name>/oauth2/idpresponse`) always resolves.
The `osmo-admin` and `osmo-user` groups are created for future role mapping but
no authorization logic is wired yet — any authenticated user reaches the UI.

The OSMO CLI and automation continue to use bearer tokens; only the browser UI
is gated by Cognito.

The AWS Load Balancer Controller IAM policy is pinned in this directory from `kubernetes-sigs/aws-load-balancer-controller/v3.2.2`.

## Runtime Validation

Status: Passed on 2026-05-04.

Scope validated:

- Applied this optional Terraform root against the live
  `aws-osmo-dev-repro-eks` cluster in `ap-northeast-2`.
- Installed AWS Load Balancer Controller through Helm with IRSA.
- Issued and DNS-validated an ACM certificate for
  `osmo.yhyoo.people.aws.dev`.
- Created an ALB-backed Kubernetes Ingress for `osmo-ui`.
- Published a Route 53 ALIAS record for `osmo.yhyoo.people.aws.dev`.
- Verified HTTPS access to the OSMO UI through the public domain.
- Left the ingress resources deployed for manual inspection.

Commands:

```bash
terraform -chdir=infra/ingress apply -auto-approve -input=false \
  -var='aws_region=ap-northeast-2' \
  -var='cluster_name=aws-osmo-dev-repro-eks' \
  -var='cluster_oidc_issuer_url=https://oidc.eks.ap-northeast-2.amazonaws.com/id/BEC2396018647BE930D361DE725F9EAF' \
  -var='cluster_oidc_provider_arn=arn:aws:iam::833277791039:oidc-provider/oidc.eks.ap-northeast-2.amazonaws.com/id/BEC2396018647BE930D361DE725F9EAF' \
  -var='vpc_id=vpc-07300fe51b332fb6f' \
  -var='domain_name=osmo.yhyoo.people.aws.dev' \
  -var='hosted_zone_id=Z00540223B45QC20879ZI' \
  -var='allowed_cidrs=["15.248.4.0/24","211.219.120.227/32","106.101.136.0/24","118.235.15.0/24","118.235.10.0/24"]'
curl -sS -D - -o /dev/null https://osmo.yhyoo.people.aws.dev/
curl -sS -D - -o /dev/null http://osmo.yhyoo.people.aws.dev/
```

Observed result:

- `terraform apply`: `Resources: 9 added, 0 changed, 0 destroyed`.
- AWS Load Balancer Controller: Helm chart `3.2.2`, image
  `public.ecr.aws/eks/aws-load-balancer-controller:v3.2.2`, deployment
  `2/2` available.
- IngressClass: `alb`, controller `ingress.k8s.aws/alb`.
- Ingress: `osmo/osmo-admin`, host `osmo.yhyoo.people.aws.dev`, backend
  `osmo-ui:80`.
- ALB:
  `aws-osmo-dev-repro-eks-admin-1233872171.ap-northeast-2.elb.amazonaws.com`,
  `internet-facing`, `active`.
- Target group: `k8s-osmo-osmoui-9e4cd737dc`, target
  `10.40.20.238:8000`, health `healthy`.
- ACM certificate: issued and validated in `ap-northeast-2` for
  `osmo.yhyoo.people.aws.dev`.
- HTTPS check returned `HTTP/2 200` with the OSMO UI HTML.
- HTTP check returned `HTTP/1.1 301 Moved Permanently` redirecting to HTTPS.
- TLS certificate subject: `CN=osmo.yhyoo.people.aws.dev`, issuer
  `Amazon RSA 2048 M01`, valid from `May 4 00:00:00 2026 GMT` to
  `Nov 17 23:59:59 2026 GMT`.
- ALB ingress is restricted to
  `15.248.4.0/24,211.219.120.227/32,106.101.136.0/24,118.235.15.0/24,118.235.10.0/24`.

## Cognito Browser Authentication — Runtime Validation

Status: Passed on 2026-07-11.

> Note: the `terraform.tfvars.example` default `cognito_domain_prefix =
> "aws-osmo-dev-repro-auth"` is rejected by Cognito — Hosted UI prefixes cannot
> contain the reserved word `aws` (`InvalidParameterException: Domain cannot
> contain reserved word: aws`). This validation used `osmo-dev-repro-auth`.

Apply command (replace `domain_name`, `hosted_zone_id`, `allowed_cidrs`,
`cognito_domain_prefix`, and `cognito_admin_email` with real values):

```bash
terraform -chdir=infra/ingress apply -input=false \
  -var='aws_region=ap-northeast-2' \
  -var='cluster_name=aws-osmo-dev-repro-eks' \
  -var='cluster_oidc_issuer_url=https://oidc.eks.ap-northeast-2.amazonaws.com/id/FE8A7D1A6AB71452658546177767328D' \
  -var='cluster_oidc_provider_arn=arn:aws:iam::913524902871:oidc-provider/oidc.eks.ap-northeast-2.amazonaws.com/id/FE8A7D1A6AB71452658546177767328D' \
  -var='vpc_id=vpc-0553e178b28dcbc6d' \
  -var='domain_name=osmo.hi-yoo.com' \
  -var='hosted_zone_id=Z042232911ZVZ3YUUX7JL' \
  -var='allowed_cidrs=["3.35.177.11/32"]' \
  -var='enable_cognito_auth=true' \
  -var='cognito_domain_prefix=osmo-dev-repro-auth' \
  -var='cognito_admin_email=admin@hi-yoo.com' \
  -var='cognito_admin_temp_password=<temp password>'
```

Checklist recorded from the live apply:

- [x] `terraform apply` created 16 resources (`16 added, 0 changed, 0
      destroyed`): Cognito user pool, Hosted UI domain, browser client, two
      groups, admin user + group membership, ACM certificate + DNS validation,
      LBC IAM role/policy/attachment, LBC Helm release, ALB Ingress, and the
      Route 53 ALIAS record.
- [x] Cognito user pool `ap-northeast-2_5kvBJAtPj`
      (`aws-osmo-dev-repro-eks-osmo`) and Hosted UI domain
      `osmo-dev-repro-auth.auth.ap-northeast-2.amazoncognito.com` — domain
      status `ACTIVE`, backed by CloudFront `d2gcbvkpcschxy.cloudfront.net`.
      Hosted UI `/login` returned `HTTP 200`.
- [x] Browser client `6npk1e9hdtgrq6k2gcfe69b1pe` — callback URL
      `https://osmo.hi-yoo.com/oauth2/idpresponse`, logout URL
      `https://osmo.hi-yoo.com`, flow `code`, scopes `openid email profile`,
      client secret generated (kept out of annotations).
- [x] Ingress `osmo/osmo-admin` annotation
      `alb.ingress.kubernetes.io/auth-type: cognito` present;
      `auth-idp-cognito` carries
      `{"userPoolARN":"arn:aws:cognito-idp:ap-northeast-2:913524902871:userpool/ap-northeast-2_5kvBJAtPj","userPoolClientID":"6npk1e9hdtgrq6k2gcfe69b1pe","userPoolDomain":"osmo-dev-repro-auth"}`
      (no secret). `auth-on-unauthenticated-request: authenticate`,
      `auth-scope: openid email profile`, `auth-session-timeout: 3600`.
- [x] Host-less catch-all rule absent — the Ingress has exactly one rule
      (`host: osmo.hi-yoo.com`). Hitting the raw ALB DNS
      (`aws-osmo-dev-repro-eks-admin-726989214.ap-northeast-2.elb.amazonaws.com`)
      over HTTPS returned `HTTP/2 404` and did not serve the OSMO UI.
- [x] Unauthenticated `GET https://osmo.hi-yoo.com/` returned `HTTP/2 302`
      redirecting to
      `https://osmo-dev-repro-auth.auth.ap-northeast-2.amazoncognito.com/oauth2/authorize?client_id=6npk1e9hdtgrq6k2gcfe69b1pe&redirect_uri=https%3A%2F%2Fosmo.hi-yoo.com%2Foauth2%2Fidpresponse&response_type=code&scope=openid%20email%20profile&state=...`
      and set the `AWSALBAuthNonce` cookie (ALB `authenticate-cognito` active).
      `GET http://osmo.hi-yoo.com/` returned `HTTP/1.1 301` to HTTPS.
- [~] Admin user `admin@hi-yoo.com` created in status `FORCE_CHANGE_PASSWORD`
      and placed in the `osmo-admin` group. Interactive first-login password
      change + UI load was not exercised here (headless environment; the admin
      CIDR allow-list is scoped to the sandbox egress IP `3.35.177.11/32`, not
      an operator browser). The unauthenticated redirect and Hosted UI `200`
      confirm the login path end to end up to the credential prompt.
- [ ] Disable check (`enable_cognito_auth=false`) not run — the Cognito-enabled
      ingress was left deployed for manual inspection.

Observed environment details:

- ALB `aws-osmo-dev-repro-eks-admin`
  (`aws-osmo-dev-repro-eks-admin-726989214.ap-northeast-2.elb.amazonaws.com`),
  `internet-facing`, state `active`; inbound restricted to `3.35.177.11/32`.
- Target group `k8s-osmo-osmoui-84aa20440a`, target `10.40.21.23:8000`, health
  `healthy`.
- ACM certificate
  `arn:aws:acm:ap-northeast-2:913524902871:certificate/b029e539-a098-4958-85a6-81ebc063b2e3`,
  subject `CN=osmo.hi-yoo.com`, issuer `Amazon RSA 2048 M01`, valid
  `Jul 11 2026` to `Jan 24 2027`.
- Route 53 ALIAS `osmo.hi-yoo.com` → ALB (zone `Z042232911ZVZ3YUUX7JL`).
- Cognito OIDC issuer
  `https://cognito-idp.ap-northeast-2.amazonaws.com/ap-northeast-2_5kvBJAtPj`.

