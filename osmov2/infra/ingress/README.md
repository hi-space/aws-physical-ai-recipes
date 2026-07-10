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
