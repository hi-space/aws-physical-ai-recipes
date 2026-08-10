# osmov2 vs sample-aws-physical-ai-toolchain 기능 비교

> 작성일: 2026-07-11
> 대상 저장소:
> - **osmov2**: `/home/ubuntu/workspace/aws-physical-ai-recipes/osmov2` (현재 프로젝트)
> - **toolchain**: `/home/ubuntu/workspace/sample-aws-physical-ai-toolchain`

## 개요

| 구분 | osmov2 (현재 프로젝트) | toolchain |
|---|---|---|
| 정체성 | AWS×NVIDIA 레퍼런스 아키텍처, 재현성·검증 중심 | 엔드투엔드 OSMO 플랫폼, 프로덕션 배포 중심 |
| OSMO 버전 | 6.2.10 (chart 1.2.1) | 6.3.1 (chart 1.3.1) |
| IaC | Terraform (root 3개 분리: core/ingress/observability) | Terraform (module 구조: platform/eks) |
| 라이선스 | - | Apache 2.0 |

## 핵심 차이점

### 1. GPU 컴퓨팅 & 노드 관리 — 가장 큰 차이

| | osmov2 | toolchain |
|---|---|---|
| 노드 프로비저닝 | **Karpenter** (동적 자동 프로비저닝, v1.12.0) | EKS Managed Node Group (고정) + Cluster Autoscaler |
| GPU 인스턴스 | **g7e** (RTX PRO 6000), g6(L4) 폴백 | **g5.2xlarge** (L40S), SPOT 옵션 |
| EFA/NCCL | ✅ EFA device plugin, 멀티노드 NCCL/DDP 벤치마크 | ❌ 없음 |

→ osmov2는 **대규모 분산 학습(멀티노드 GPU)**에 강점, toolchain은 단일/소규모 GPU 중심.

### 2. 인증(Authentication) — toolchain이 앞섬

| | osmov2 | toolchain |
|---|---|---|
| 인증 체계 | 단순 admin 토큰 (port-forward 접근) | ✅ **Keycloak** (realm, OAuth2 브라우저/디바이스 플로우) |
| Gateway | Nginx 내부 라우터 | ✅ **Envoy + oauth2-proxy** (JWT 검증, RBAC) |
| IdP 옵션 | 없음 | Keycloak(기본) + **Cognito** + Identity Center |
| RBAC | 없음 | osmo-admin / osmo-user / osmo-backend 역할 |

### 3. 접근 & 네트워크 노출

| | osmov2 | toolchain |
|---|---|---|
| 기본 접근 | Private (port-forward), 선택적 HTTPS ingress | ALB + Route53 + ACM 공개 HTTPS |
| WAF | ❌ | ✅ WAF v2 (IP 허용목록, rate limit 2000 req/5min) |
| VPC Endpoints | 기본 사용 안 함 | ✅ S3/ECR/STS/SecretsManager/Logs/APS |

### 4. 관측성(Observability)

| | osmov2 | toolchain |
|---|---|---|
| 메트릭 | AMP+AMG 또는 in-cluster Prometheus (선택) | AMP 관리형 스크래퍼 |
| 로그 | (기본 미포함) | ✅ Fluent Bit → CloudWatch |
| 보안 모니터링 | ❌ | ✅ GuardDuty, Security Hub, VPC Flow Logs |

### 5. 워크플로우 예제 — osmov2가 풍부

| | osmov2 | toolchain |
|---|---|---|
| 개수 | **14개** (검증 기록 포함) | 10개 |
| 대표 예제 | GR00T finetune, OpenPI LIBERO, Cosmos Reason2, HY-World, Lyra2, **6단계 nut-pouring 파이프라인** | Isaac Sim, Cosmos Transfer SDG, pick&place 학습 |
| 검증 상태 | ✅ 각 예제 `validation.md` + 아티팩트 | 스켈레톤/샘플 중심 |

### 6. 배포 모드 & 유연성

- **toolchain만 있음**: 3가지 배포 모드(full / control-plane-only / backend-only), pre-commit 훅(Checkov/TFLint/ShellCheck/Gitleaks), dev/prod tfvars 프리셋
- **osmov2만 있음**: 재현성 보장 문서(AZ 핀), 버전 매트릭스, prewarm/cleanup 스크립트

## 상세 인벤토리

### osmov2 구현 기능

- **IaC**: Terraform (>= 1.5, < 2.0), AWS Provider ~> 5.0. root 3개(core/ingress/observability). VPC/EKS/RDS 공식 모듈 사용.
- **네트워킹**: VPC(기본 10.40.0.0/16), 멀티 AZ(2-4), private 서브넷, EFA용 self-referencing SG.
- **EKS**: 1.34/1.35, private 엔드포인트 기본. Addon: CoreDNS, Pod Identity Agent, kube-proxy, VPC CNI(prefix delegation).
- **컴퓨팅**: 시스템 노드(m7i.2xlarge), Karpenter GPU 노드풀(aws-osmo-g7e / 옵션 aws-osmo-g6), GPU Operator v26.3.1, EFA device plugin v0.5.26.
- **스토리지/데이터**: RDS PostgreSQL 16.6, ElastiCache Redis 7.1, S3 아티팩트 버킷(KMS), ECR(IMMUTABLE).
- **암호화/시크릿**: KMS 키(회전), Secrets Manager(runtime 자격증명).
- **IAM**: OSMO IRSA 서비스 계정, workflow-data IAM 사용자, Karpenter 노드 롤.
- **OSMO 설치**: Helm(osmo/service, osmo/backend, chart 1.2.1, OSMO 6.2.10), KAI Scheduler v0.13.0, Nginx 내부 라우터.
- **관측성(선택)**: AMP+AMG 또는 in-cluster kube-prometheus-stack.
- **워크플로우**: 14개 검증된 예제.
- **문서**: architecture, security, reproducibility, observability, osmo-compatibility, version-matrix.

### toolchain 구현 기능

- **IaC**: Terraform (>= 1.5), AWS Provider >= 5.0. `001-iac/` root + platform/eks 모듈. `resource_suffix` 필수.
- **네트워킹**: VPC(10.0.0.0/16), public/private/database/elasticache 서브넷, VPC Endpoints(S3/ECR/STS/Secrets/Logs/APS).
- **EKS**: 1.35, public+private 엔드포인트. Addon: CoreDNS, VPC CNI, kube-proxy, EBS CSI.
- **컴퓨팅**: 시스템 노드(m6i.xlarge), GPU 노드(g5.2xlarge, 기본 0대, SPOT 옵션), Canonical Ubuntu EKS AMI 지원, GPU Operator v24.9.0, KAI Scheduler v0.12.4.
- **스토리지/데이터**: RDS PostgreSQL 15.17, ElastiCache Redis(2 노드 failover), S3 2개(workflows/datasets), KMS, Secrets Manager.
- **인증**: Keycloak(realm, OAuth2 browser/device 클라이언트) 기본, Cognito/Identity Center 옵션. Envoy + oauth2-proxy 게이트웨이, JWT authn, RBAC authz 사이드카.
- **배포**: 5단계 스크립트(01 AWS 사전요소 → 02 GPU 인프라 → 03 Keycloak → 04 control-plane → 05 backend). 3가지 배포 모드.
- **관측성**: Fluent Bit → CloudWatch, AMP 관리형 스크래퍼(kubelet/DCGM), VPC Flow Logs.
- **보안**: WAF v2, GuardDuty, Security Hub, IRSA, pre-commit(Checkov/TFLint/ShellCheck/Gitleaks).
- **워크플로우**: 10개 예제(hello_world, gpu_test, cosmos_transfer, pick_and_place_training 등).
- **문서**: deployment-modes, TEARDOWN, troubleshooting.

## 요약

- **osmov2** = "검증된 GPU 학습 레퍼런스" — Karpenter + EFA로 멀티노드 분산 학습과 재현성/검증된 physical AI 워크플로우에 특화. 인증·거버넌스는 최소화(사설 접근).
- **toolchain** = "프로덕션 플랫폼" — Keycloak/Envoy 인증, WAF, 공개 HTTPS, 관측성, 배포 모드 등 엔터프라이즈 운영 기능 완비. 대신 GPU는 고정 노드그룹 기반으로 대규모 분산 학습 인프라(EFA)는 없음.

## osmov2에 이식 검토 대상 (toolchain → osmov2)

1. **인증 & RBAC** — Cognito/Identity Center 기반 인증 + Envoy/oauth2-proxy 게이트웨이, osmo-admin/user/backend RBAC. *(현재 작업 대상)*
2. 보안 강화 — WAF v2, GuardDuty, Security Hub, VPC Flow Logs, VPC Endpoints.
3. 로깅 — Fluent Bit → CloudWatch.
4. 배포 모드 & pre-commit 훅.
