# CloudFront + WAF IP Whitelist

Domain-free HTTPS access to OSMO Admin UI and Grafana via CloudFront default certificates (`*.cloudfront.net`).

## Architecture

```
User (whitelisted IP)
  -> CloudFront (HTTPS, WAF IP check)
    -> ALB (HTTP, port 80)
      -> EKS (osmo-ui / grafana)
```

A single WAF WebACL with an IP set is shared across both distributions. Only IPs in the allow list can reach the services; all others receive 403.

## Prerequisites

- OSMO UI ALB deployed via `infra/ingress`
- Grafana ALB deployed via `scripts/deploy-observability-incluster.sh`
- ALB security groups must allow inbound from CloudFront (add the AWS-managed prefix list `com.amazonaws.global.cloudfront.origin-facing` to port 80)

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

Add or remove IPs via Terraform (`allowed_cidrs` in `terraform.tfvars`) or directly via AWS CLI:

```bash
aws wafv2 update-ip-set \
  --name osmo-allowed-ips \
  --scope CLOUDFRONT \
  --region us-east-1 \
  --id <ip-set-id> \
  --lock-token <lock-token> \
  --addresses "1.2.3.4/32" "5.6.7.8/32"
```
