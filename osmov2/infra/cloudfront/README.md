# CloudFront + WAF IP Whitelist

Domain-free HTTPS access to OSMO Admin UI and Grafana via CloudFront default certificates (`*.cloudfront.net`).

## Architecture

```
User (whitelisted IP)
  -> CloudFront (HTTPS, WAF IP check)
    -> osmo-gateway LB / grafana ALB (HTTP, port 80)
      -> EKS (osmo gateway: envoy + oauth2-proxy / grafana)
```

A single WAF WebACL with an IP set is shared across both distributions. Only IPs in the allow list can reach the services; all others receive 403.

When SSO is enabled, the OSMO origin must be the `osmo-gateway` Service LoadBalancer (envoy + oauth2-proxy), not the plain `osmo-ui` ingress. Pointing CloudFront at the UI ingress bypasses oauth2-proxy and produces a redirect loop.

## Prerequisites

- OSMO gateway LoadBalancer available: `kubectl get svc -n osmo osmo-gateway`
- Grafana ALB deployed via `scripts/deploy-observability-incluster.sh`
- Origin security groups must allow inbound from CloudFront (the `osmo-gateway` Service LB already allows 0.0.0.0/0 on 80/443; for ingress-based origins add the AWS-managed prefix list `com.amazonaws.global.cloudfront.origin-facing` to port 80)

## Deploy

```bash
cd infra/cloudfront
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars with your ALB DNS names and allowed CIDRs
terraform init
terraform apply
```

## Outputs

| Output | Description |
|--------|-------------|
| `osmo_ui_cloudfront_domain` | OSMO UI access URL (`https://<value>`) |
| `grafana_cloudfront_domain` | Grafana access URL (`https://<value>`) |
| `waf_ip_set_arn` | WAF IP set ARN for managing allowed IPs |

## Post-deploy: Update OSMO Grafana Link

After deploying, update the OSMO backend so the overview tab links to the Grafana CloudFront endpoint:

```bash
GRAFANA_URL=https://$(terraform output -raw grafana_cloudfront_domain) \
  ../../scripts/update-grafana-url.sh
```

## Managing IP Whitelist

Add or remove IPs via Terraform (`allowed_cidrs`) or directly via AWS CLI:

This directory holds several tfvars files (`terraform.tfvars`, `terraform.use1.tfvars`, `terraform.usw2.tfvars`) for different regional deploys, and the plain `terraform.tfvars` is not necessarily the one in effect. Confirm the live allow list against the IP set rather than reading a tfvars file:

```bash
aws wafv2 get-ip-set --name osmo-allowed-ips --scope CLOUDFRONT --region us-east-1 \
  --id <ip-set-id> --query 'IPSet.Addresses'
```


```bash
aws wafv2 update-ip-set \
  --name osmo-allowed-ips \
  --scope CLOUDFRONT \
  --region us-east-1 \
  --id <ip-set-id> \
  --lock-token <lock-token> \
  --addresses "1.2.3.4/32" "5.6.7.8/32"
```

### Adding the machine you are working from

A host that is not in the allow list gets `403 Request blocked` from CloudFront.
This is easy to misread, because Cognito authentication happens directly against
the pool and succeeds regardless — `scripts/osmo-cli-login.sh` reports success
and writes `login.yaml`, and only the next API call fails. Check reachability
first:

```bash
curl -o /dev/null -w '%{http_code}\n' \
  https://$(terraform output -raw osmo_ui_cloudfront_domain)/api/version
```

The Terraform path is the durable fix — a direct `update-ip-set` is reverted by
the next apply. Add the CIDR to the tfvars file that matches the workspace, then
apply with that file explicitly. Terraform auto-loads `terraform.tfvars`
regardless of workspace, so omitting `-var-file` here plans against the wrong
`name_prefix` and produces an alarming diff:

```bash
curl -s https://checkip.amazonaws.com          # your egress IP
terraform workspace show                       # e.g. use1
# add "<ip>/32" to allowed_cidrs in terraform.<workspace>.tfvars, then:
terraform apply -var-file=terraform.use1.tfvars \
  -var "osmo_alb_dns_name=$(kubectl -n osmo get svc osmo-gateway \
    -o jsonpath='{.status.loadBalancer.ingress[0].hostname}')"
```

The `-var` overrides matter because `osmo_alb_dns_name`/`grafana_alb_dns_name`
hold placeholders in the per-region tfvars (the SSO bootstrap injects the real
values), so applying without them points the distribution origins at
`placeholder.elb...`.

To test the auth chain without touching the allow list at all, port-forward the
gateway instead. Requests still traverse Envoy `jwt_authn` and the authz
sidecar, so role enforcement is exercised for real:

```bash
kubectl -n osmo port-forward svc/osmo-gateway 9200:80 &
OSMO_CLI_USER=alice@example.com OSMO_GATEWAY_URL=http://127.0.0.1:9200 \
  ../../scripts/osmo-cli-login.sh
```
