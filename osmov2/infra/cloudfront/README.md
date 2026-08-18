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
