# OSMO Admin Ingress

> 이 문서는 [README.md](README.md)(영문)의 한국어 번역본입니다.

이 선택적 Terraform root는 AWS Load Balancer Controller, ACM, Route 53, 그리고 ALB 기반 Kubernetes Ingress를 사용하여 OSMO Web UI를 HTTPS로 노출합니다.

기본 배포는 비공개 상태로 유지됩니다. 관리자 도메인과 제한된 소스 CIDR 허용 목록이 준비된 경우에만 이 root를 적용하세요.

```bash
cp infra/ingress/terraform.tfvars.example infra/ingress/terraform.tfvars

terraform -chdir=infra/core output -raw cluster_name
terraform -chdir=infra/core output -raw cluster_oidc_issuer_url
terraform -chdir=infra/core output -raw cluster_oidc_provider_arn
terraform -chdir=infra/core output -raw vpc_id

terraform -chdir=infra/ingress init
terraform -chdir=infra/ingress apply
```

필수 입력값:

- `domain_name`: 완전한 관리자 UI 호스트명, 예시: `osmo.example.com`.
- `hosted_zone_id`: 해당 호스트명을 소유하는 Route 53 hosted zone.
- `allowed_cidrs`: 신뢰할 수 있는 관리자 CIDR 목록. `0.0.0.0/0`은 허용되지 않습니다.

Ingress는 비공개 `osmo-ui` 서비스로만 라우팅합니다. UI 배포가 클러스터 내부의 `osmo-service`로 API 호출을 프록시하므로, 공개 ALB에서 API 서비스를 별도로 노출할 필요가 없습니다.

AWS Load Balancer Controller IAM 정책은 이 디렉터리에 `kubernetes-sigs/aws-load-balancer-controller/v3.2.2`에서 고정되어 있습니다.

## 런타임 검증

상태: 2026-05-04 통과.

검증 범위:

- `ap-northeast-2`의 `aws-osmo-dev-repro-eks` 클러스터에 이 선택적 Terraform root를 적용했습니다.
- IRSA를 통해 Helm으로 AWS Load Balancer Controller를 설치했습니다.
- `osmo.yhyoo.people.aws.dev`에 대한 ACM 인증서를 발급하고 DNS 유효성 검증을 완료했습니다.
- `osmo-ui`용 ALB 기반 Kubernetes Ingress를 생성했습니다.
- `osmo.yhyoo.people.aws.dev`에 대한 Route 53 ALIAS 레코드를 게시했습니다.
- 공개 도메인을 통해 OSMO UI에 HTTPS로 접근 가능함을 확인했습니다.
- 수동 점검을 위해 ingress 리소스를 배포된 상태로 유지했습니다.

명령어:

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

관찰 결과:

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
- ACM 인증서: `ap-northeast-2`에서 `osmo.yhyoo.people.aws.dev`에 대해 발급 및 유효성 검증 완료.
- HTTPS 확인 결과 `HTTP/2 200`과 OSMO UI HTML이 반환되었습니다.
- HTTP 확인 결과 HTTPS로 리다이렉트하는 `HTTP/1.1 301 Moved Permanently`가 반환되었습니다.
- TLS 인증서 subject: `CN=osmo.yhyoo.people.aws.dev`, issuer
  `Amazon RSA 2048 M01`, 유효 기간 `May 4 00:00:00 2026 GMT` ~ `Nov 17 23:59:59 2026 GMT`.
- ALB ingress는
  `15.248.4.0/24,211.219.120.227/32,106.101.136.0/24,118.235.15.0/24,118.235.10.0/24`로 제한되어 있습니다.
