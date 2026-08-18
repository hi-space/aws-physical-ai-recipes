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

### 작업 중인 머신을 허용 목록에 추가하기

허용 목록에 없는 호스트는 CloudFront에서 `403 Request blocked`를 받습니다. 이걸
오진하기 쉬운데, Cognito 인증은 사용자 풀에 직접 붙어서 허용 목록과 무관하게
성공하기 때문입니다 — `scripts/osmo-cli-login.sh`는 성공했다고 보고하고
`login.yaml`까지 쓰며, 실패는 다음 API 호출에서야 드러납니다. 도달성을 먼저
확인하세요:

```bash
curl -o /dev/null -w '%{http_code}\n' \
  https://$(terraform output -raw osmo_ui_cloudfront_domain)/api/version
```

지속적인 해결책은 Terraform 경로입니다 — `update-ip-set`으로 직접 넣은 값은 다음
apply에서 되돌아갑니다. workspace에 맞는 tfvars에 CIDR을 추가하고 그 파일을 명시해
apply하세요. Terraform은 workspace와 무관하게 `terraform.tfvars`를 자동 로드하므로,
여기서 `-var-file`을 빼면 엉뚱한 `name_prefix`로 계산되어 놀랄 만한 diff가 나옵니다:

```bash
curl -s https://checkip.amazonaws.com          # 내 egress IP
terraform workspace show                       # 예: use1
# terraform.<workspace>.tfvars 의 allowed_cidrs 에 "<ip>/32" 추가 후:
terraform apply -var-file=terraform.use1.tfvars \
  -var "osmo_alb_dns_name=$(kubectl -n osmo get svc osmo-gateway \
    -o jsonpath='{.status.loadBalancer.ingress[0].hostname}')"
```

`-var` 오버라이드가 필요한 이유는 리전별 tfvars의
`osmo_alb_dns_name`/`grafana_alb_dns_name`이 placeholder이기 때문입니다(실제 값은
SSO 부트스트랩이 주입). 이걸 빼고 apply하면 배포의 origin이
`placeholder.elb...`를 가리키게 됩니다.

허용 목록을 아예 건드리지 않고 인증 체인만 시험하려면 게이트웨이에 포트포워드하세요.
이 경로도 Envoy `jwt_authn`과 authz 사이드카를 그대로 통과하므로 역할 집행이 실제로
검증됩니다:

```bash
kubectl -n osmo port-forward svc/osmo-gateway 9200:80 &
OSMO_CLI_USER=alice@example.com OSMO_GATEWAY_URL=http://127.0.0.1:9200 \
  ../../scripts/osmo-cli-login.sh
```
