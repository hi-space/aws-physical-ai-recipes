# CloudFront + WAF IP Whitelist

> 이 문서는 [README.md](README.md)(영문)의 한국어 번역본입니다.

CloudFront 기본 인증서(`*.cloudfront.net`)를 통해 OSMO Admin UI와 Grafana에 도메인 없이 HTTPS로 접근합니다.

## 아키텍처

```
User (whitelisted IP)
  -> CloudFront (HTTPS, WAF IP check)
    -> osmo-gateway LB / grafana ALB (HTTP, port 80)
      -> EKS (osmo gateway: envoy + oauth2-proxy / grafana)
```

하나의 WAF WebACL과 IP 세트를 두 배포판에서 공유합니다. 허용 목록에 있는 IP만 서비스에 접근할 수 있으며, 그 외 모든 요청은 403을 반환합니다.

SSO를 활성화한 경우 OSMO 오리진은 일반 `osmo-ui` ingress가 아닌 `osmo-gateway` Service LoadBalancer(envoy + oauth2-proxy)여야 합니다. CloudFront를 UI ingress에 직접 연결하면 oauth2-proxy가 우회되어 리다이렉트 루프가 발생합니다.

## 사전 조건

- OSMO gateway LoadBalancer 가용 여부 확인: `kubectl get svc -n osmo osmo-gateway`
- `scripts/deploy-observability-incluster.sh`를 통해 Grafana ALB 배포 완료
- 오리진 보안 그룹에서 CloudFront의 인바운드를 허용해야 합니다 (`osmo-gateway` Service LB는 80/443 포트에 0.0.0.0/0을 이미 허용하고 있으며, ingress 기반 오리진의 경우 AWS 관리형 prefix list `com.amazonaws.global.cloudfront.origin-facing`을 80번 포트에 추가하세요)

## 배포

```bash
cd infra/cloudfront
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars with your ALB DNS names and allowed CIDRs
terraform init
terraform apply
```

## 출력값

| 출력값 | 설명 |
|--------|-------------|
| `osmo_ui_cloudfront_domain` | OSMO UI 접근 URL (`https://<value>`) |
| `grafana_cloudfront_domain` | Grafana 접근 URL (`https://<value>`) |
| `waf_ip_set_arn` | 허용 IP 관리를 위한 WAF IP 세트 ARN |

## 배포 후: OSMO Grafana 링크 업데이트

배포 완료 후, OSMO 백엔드의 개요 탭이 Grafana CloudFront 엔드포인트를 가리키도록 업데이트합니다:

```bash
GRAFANA_URL=https://$(terraform output -raw grafana_cloudfront_domain) \
  ../../scripts/update-grafana-url.sh
```

## IP Whitelist 관리

Terraform(`allowed_cidrs`)을 통하거나 AWS CLI로 직접 IP를 추가하거나 제거할 수 있습니다:

이 디렉터리에는 리전별 tfvars가 여러 개 있고(`terraform.tfvars`, `terraform.use1.tfvars`, `terraform.usw2.tfvars`), 그중 `terraform.tfvars`가 반드시 적용된 파일이라는 보장은 없습니다. 현재 허용 목록은 tfvars를 읽지 말고 IP 세트에서 직접 확인하세요:

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
