# osmov2 vs sample-aws-physical-ai-toolchain 비교 및 차용 설계 참고

> **목적**: `sample-aws-physical-ai-toolchain`(이하 **toolchain**)에 구현되어 있으나 이 프로젝트(**osmov2**)에는 없는 기능 중,
> osmov2로 가져올 만한 것을 식별하고 설계에 참고하기 위한 문서.
>
> - **비교 기준일**: 2026-07-12
> - **osmov2 경로**: `/home/ubuntu/workspace/aws-physical-ai-recipes/osmov2`
> - **toolchain 경로**: `/home/ubuntu/workspace/sample-aws-physical-ai-toolchain/osmo-on-aws`
> - **공통점**: 둘 다 NVIDIA OSMO 6.3.1 (Helm chart 1.3.1)을 Amazon EKS에 배포하는 AWS 레퍼런스 아키텍처

---

## 0. 한 줄 요약

| | osmov2 | toolchain |
|---|--------|-----------|
| **정체성** | GPU 워크로드 **레시피/워크플로우 카탈로그** (실측 검증 중심) | **엔터프라이즈 플랫폼 배포** (보안·인증·HA 중심) |
| **강점** | 최신 하드웨어(Blackwell+EFA), 검증된 물리AI 파이프라인, Karpenter 동적 프로비저닝, 재현성 | 인증(IdP), 보안 거버넌스, 배포 유연성, 관측성, 모듈화된 IaC |
| **약점** | 인증 없음, 보안 거버넌스 얕음, 단일 배포 모드 | 워크로드 예제 얇음(상당수 스켈레톤), Karpenter/EFA/최신 GPU 미지원 |

→ **두 프로젝트는 상호 보완적.** toolchain의 운영·보안·거버넌스 기능을 osmov2의 검증된 워크로드 카탈로그에 이식하면 이상적.

---

## 1. 전체 기능 비교 매트릭스

### 1.1 GPU 노드 관리

| 항목 | osmov2 | toolchain |
|------|--------|-----------|
| 프로비저닝 | **Karpenter** (NodePool/EC2NodeClass) ✅ 도입됨 (Plan A) | EKS 관리형 노드그룹 + Cluster Autoscaler |
| 스케일 다운 | `WhenEmptyOrUnderutilized`, 5분 consolidation, 24h 만료 | Autoscaler pending-pod 기반 0→10 |
| 최소 노드 | 0 (즉시 생성) | dev min=0/max=10, prod min=2/max=20 |
| 프리워밍 | `prewarm-gpu-node.sh` (hold pod) | 없음 |
| GPU Operator 드라이버 | 비활성 (AMI 내장, 부팅 빠름) | 활성 (v24.9.0, 런타임 설치 580.126.16) |
| KAI 스케줄러 | v0.13.0 (PodGroup CRD) | v0.12.4 |
| capacity type | On-Demand (기본) + Spot opt-in ✅ 도입됨 (Plan A) | On-Demand + **Spot 지원** |
| 관리형 모드 | ✅ 도입됨 (Plan A: Cluster Autoscaler 대체 경로) | EKS 관리형 노드그룹 + Cluster Autoscaler |
| EFA 멀티노드 | **지원** (device plugin v0.5.26) | 미지원 |

### 1.2 하드웨어

| 항목 | osmov2 | toolchain |
|------|--------|-----------|
| 주력 GPU | **G7e / RTX PRO 6000 Blackwell (~98GB)** | G5 / L40S (48GB) |
| CUDA | 13.0 | 12.6 |
| 폴백 GPU | ✅ 도입됨 (Plan A: g6/L4, g5/A10G, g6e/L40S 자동 전환) | 없음 |
| AMI | EKS AL2023 NVIDIA 핀 고정 | Canonical Ubuntu EKS (사용자 조회) |
| 시스템 노드 | m7i.2xlarge ×3~5 | m6i.xlarge ×2~6 |
| GPU 루트 볼륨 | 1024Gi | 500Gi |

### 1.3 워크플로우

| 항목 | osmov2 | toolchain |
|------|--------|-----------|
| 예제 수 | 13개+ | 10개 |
| 검증 | 전부 `validation.md` 실측 기록 | 4개 실동작 / 6개 스켈레톤 |
| 플랫폼 노출 | `g7e-rtx-pro-6000` + `g6-l4` | `l40s` 단일 |
| 대표 워크로드 | GR00T, OpenPI, Isaac Lab RSL-RL, Cosmos Reason2, HY-World, Lyra, EFA 벤치 | Isaac Sim livestream, Cosmos Transfer SDG |
| E2E 멀티스테이지 | nut-pouring 6단계 (실측) | pick_and_place (스켈레톤) |

### 1.4 운영/거버넌스 (← toolchain 우위 영역)

| 항목 | osmov2 | toolchain |
|------|--------|-----------|
| 인증 (IdP) | ❌ (backend-operator 토큰만) | ✅ Keycloak / Cognito / IAM Identity Center |
| 배포 모드 | 단일 (full) | ✅ full / control-plane-only / backend-only |
| Secrets 동기화 | 수동/스크립트 | ✅ External Secrets Operator |
| 보안 스캔 | 부분 (`scan-public-ingress.sh`) | ✅ pre-commit (Checkov/TFLint/ShellCheck/Gitleaks) |
| 위협 탐지 | ❌ | ✅ GuardDuty / Security Hub / VPC Flow Logs |
| WAF | ❌ | ✅ ALB용 WAF (rate limit, IP allow-list) |
| IaC 모듈화 | 단일 root (core/observability/ingress) | ✅ platform/eks 모듈 분리 |
| 환경 프리셋 | tfvars.example 1종 | ✅ dev / prod 프리셋 |
| Terraform state | 로컬 | ✅ 로컬 / S3+DynamoDB / GitLab managed |
| DNS/TLS 자동화 | ingress 모듈 (선택) | ✅ Route53 + ACM (OSMO/auth/Keycloak) |

---

## 2. toolchain에서 차용할 만한 기능 (우선순위별)

> 평가 기준: **가치(운영·보안 개선 정도)** × **osmov2 철학(재현성·deploy→run→destroy) 적합성** × **구현 비용**

### 🟢 우선순위 High — 가치 높고 osmov2 철학과 정합

#### A. IaC 보안 스캔 pre-commit 파이프라인
- **toolchain 구현**: `.pre-commit-config.yaml` + `.checkov.yaml` + `.tflint.hcl` + `.shellcheckrc` + `.gitleaksignore`
  - Checkov(IaC 보안), TFLint(Terraform lint), ShellCheck(쉘 스크립트), Gitleaks(시크릿 탐지), terraform fmt
- **왜 가져오나**: osmov2는 쉘 스크립트 22개 + Terraform 다수인데 정적 검증 자동화가 없음. 재현성 프로젝트일수록 커밋 게이트가 품질을 지켜줌.
- **osmov2 적용 설계**:
  - 루트에 `.pre-commit-config.yaml` 추가, `scripts/*.sh` 대상 ShellCheck, `infra/**/*.tf` 대상 Checkov/TFLint 적용
  - `versions.yaml`의 핀 고정 철학과 정합 → 훅 버전도 핀 고정
  - CI(있다면)에도 동일 훅 연결
- **비용**: 낮음 (설정 파일 이식 + 기존 코드 위반 사항 정리)
- **참고 파일**: `osmo-on-aws/.pre-commit-config.yaml`, `osmo-on-aws/001-iac/.checkov.yaml`

#### B. dev / prod 환경 tfvars 프리셋
- **toolchain 구현**: `terraform.tfvars.dev.example` (비용 최적: single NAT, t3.medium RDS, spot GPU) / `terraform.tfvars.prod.example` (HA: multi-AZ NAT, r6g RDS, on-demand, deletion protection)
- **왜 가져오나**: osmov2는 `dev-repro` vs `reference-ha` 개념을 문서에서 언급하지만 tfvars 프리셋이 1종뿐. 실제 프리셋을 제공하면 사용자 온보딩·재현이 쉬워짐.
- **osmov2 적용 설계**:
  - `infra/core/terraform.tfvars.dev-repro.example`(현행 default 계승) / `terraform.tfvars.reference-ha.example` 분리
  - HA 프리셋: RDS multi-AZ, Redis failover, dual NAT, deletion protection, Secrets 보존기간>0
- **비용**: 낮음
- **참고 파일**: `osmo-on-aws/001-iac/terraform.tfvars.{dev,prod}.example`

#### C. External Secrets Operator (ESO) 기반 시크릿 주입
- **toolchain 구현**: `01-deploy-aws-prerequisites.sh`에서 ESO 설치 + ClusterSecretStore로 AWS Secrets Manager ↔ K8s Secret 자동 동기화
- **왜 가져오나**: osmov2는 이미 Secrets Manager를 쓰지만 OSMO/워크로드로의 주입은 스크립트가 수동 처리. ESO를 쓰면 시크릿 로테이션·감사가 표준화되고 스크립트가 단순해짐.
- **osmov2 적용 설계**:
  - `scripts/deploy-eso.sh` 신규 (선택적 단계) + IRSA 역할 추가 (`infra/core`에서 Secrets Manager read 권한)
  - NGC API key, HF token, DB/Redis 자격증명을 ExternalSecret CRD로 관리
  - **주의**: deploy→destroy 사이클과 충돌하지 않도록 opt-in으로 설계
- **비용**: 중간 (IRSA + Helm + CRD 매핑)
- **참고 파일**: `osmo-on-aws/002-setup/01-deploy-aws-prerequisites.sh`

### 🟡 우선순위 Medium — 가치 높으나 osmov2 철학과 부분 상충 (opt-in 권장)

#### D. 인증 / IdP 통합 (Keycloak / Cognito / IAM Identity Center)
- **toolchain 구현**: `03-deploy-keycloak.sh` + `modules/platform/cognito.tf` + `identity-center.tf`. realm `osmo`, 클라이언트 `osmo-browser-flow`(브라우저) / `osmo-device`(CLI device flow)
- **왜 가져오나**: osmov2에는 사용자 인증이 전혀 없음(backend-operator 토큰만). 여러 사용자가 공유하거나 장기 운영하는 시나리오에서는 필수.
- **osmov2 적용 설계**:
  - **opt-in 모듈**로 추가 (`infra/auth/` 또는 `scripts/deploy-auth.sh`). 기본 dev-repro 경로는 인증 없이 유지 (재현성·저비용).
  - Cognito 우선 권장 (관리형, Keycloak보다 운영 부담↓). Keycloak은 셀프호스트 옵션.
  - OSMO 6.3 ConfigMap의 roles(`osmo-admin`/`osmo-user` 등) + external_roles 매핑 활용
- **비용**: 높음 (IdP 프로비저닝 + OIDC 클라이언트 + OSMO 연동 + 문서화)
- **주의**: osmov2의 "deploy→validate→destroy" 단명 워크플로우에는 과할 수 있음 → reference-ha 프리셋 전용 기능으로 위치시킬 것
- **참고 파일**: `osmo-on-aws/002-setup/03-deploy-keycloak.sh`, `modules/platform/{cognito,identity-center}.tf`

#### E. 배포 모드 분리 (control-plane-only / backend-only)
- **toolchain 구현**: `docs/deployment-modes.md`. 중앙 제어평면 클러스터 + 원격 GPU 백엔드 클러스터 연결 패턴. 배포 스크립트가 4단계(control-plane) / 5단계(backend)로 분리.
- **왜 가져오나**: osmov2는 단일 클러스터(full)만 지원. 다중 리전/다중 팀이 하나의 OSMO 제어평면을 공유하고 GPU는 분산 배치하는 시나리오에 유용.
- **osmov2 적용 설계**:
  - `deploy-osmo.sh`를 `--mode full|control-plane|backend` 플래그로 분기
  - backend 모드는 외부 제어평면 endpoint + 서비스 토큰을 입력으로 받음
  - Karpenter NodePool은 backend 모드에서만 배포
- **비용**: 높음 (스크립트 재구조화 + 검증 매트릭스 확대)
- **참고 파일**: `osmo-on-aws/docs/deployment-modes.md`, `002-setup/04·05-*.sh`

#### F. Terraform IaC 모듈화 (platform / eks 분리)
- **toolchain 구현**: `001-iac/modules/platform/`(VPC·RDS·ElastiCache·S3·KMS·Secrets·DNS·WAF) + `modules/eks/`(cluster·node-groups·irsa·addons). root는 오케스트레이션만.
- **왜 가져오나**: osmov2 `infra/core/main.tf`는 548줄 단일 파일. 모듈화하면 재사용·테스트·부분 배포가 쉬워짐.
- **osmov2 적용 설계**:
  - `infra/core`를 `modules/platform` + `modules/eks`로 리팩터링 (기능 변경 없이 구조만)
  - **주의**: 대규모 리팩터링 → 회귀 테스트(전체 E2E 재실행) 필수. 재현성 프로젝트라 검증 비용 큼.
- **비용**: 높음 (리팩터링 + 전체 재검증)
- **판단**: 가치는 있으나 급하지 않음. 다른 기능 추가 시 점진적으로 모듈 추출 권장.

### 🔵 우선순위 Low / 선택 — 특정 요구 시에만

#### G. WAF + 강화된 ALB 보안
- **toolchain 구현**: `modules/platform/waf.tf`, `alb-sg.tf` (rate limit, IP allow-list)
- **osmov2 상태**: `infra/ingress` 모듈이 이미 ALB + ACM + CIDR allow-list 지원. WAF만 추가하면 됨.
- **적용**: ingress 모듈에 optional WAF WebACL 변수 추가. HTTPS admin ingress를 실제로 노출할 때만 의미.
- **비용**: 낮음

#### H. GuardDuty / Security Hub / VPC Flow Logs
- **toolchain 구현**: `modules/platform/security.tf`
- **osmov2 판단**: 계정 수준 보안 서비스 → 보통 조직의 landing zone에서 이미 활성. 단명 클러스터에 프로젝트가 켜는 건 부적합. **문서에 "계정 수준에서 활성 권장" 안내만 추가**하는 것으로 충분.
- **비용**: 낮음 (문서만) / 실제 활성화는 opt-in

#### I. CloudWatch Logs (Fluent Bit) 로그 집계
- **toolchain 구현**: `observability.tf`, Fluent Bit DaemonSet → CloudWatch Logs (JSON, 30일 보존)
- **osmov2 상태**: 이미 AMP/AMG + in-cluster Prometheus/Grafana 관측성 보유 (메트릭 중심).
- **적용**: 로그 집계가 필요하면 관측성 옵션에 CloudWatch Logs 경로 추가. 우선순위 낮음(메트릭으로 충분한 경우 많음).
- **비용**: 중간

---

## 3. osmov2가 이미 우위이므로 가져올 필요 없는 것

- **GPU 노드 관리**: Karpenter > Cluster Autoscaler (동적·제로스케일·프리워밍). 유지.
- **하드웨어**: G7e/Blackwell + EFA 멀티노드 > G5/L40S 단일노드. 유지.
- **워크플로우 카탈로그**: 실측 검증된 13개 > 스켈레톤 다수. 유지.
- **재현성**: `versions.yaml` 전면 핀 고정 + validation.md 관행. 유지.

단, toolchain의 **Spot capacity type**은 osmov2 Karpenter NodePool에 옵션으로 추가 검토 가치 있음 (대규모 훈련 비용 절감). → 아래 참고.

### 보너스: Karpenter NodePool에 Spot 옵션 추가
- ✅ **도입됨 (Plan A)**: `KARPENTER_CAPACITY_TYPE` 환경변수로 `on-demand,spot` 혼합 지원 시작.
- 재현성 벤치마크는 On-Demand 유지(기본값), 장시간 훈련(nut-pouring 등)은 Spot 옵션 제공 → 비용↓
- **주의**: Spot 중단이 워크플로우 재현성에 영향 → 기본 off, opt-in 환경변수로 설계.

---

## 4. 권장 도입 로드맵

### Phase 1 — 저비용·고가치 (즉시)
1. **A. pre-commit 보안 스캔 파이프라인** 이식
2. **B. dev-repro / reference-ha tfvars 프리셋** 분리
3. **H·G. 보안 문서 보강** (GuardDuty/Security Hub 계정수준 권장 안내 + ingress WAF 옵션)

### Phase 2 — 운영 표준화 (중기)
4. **C. External Secrets Operator** opt-in 단계 추가
5. **F. IaC 모듈화** 점진적 착수 (Phase 3 기능 추가와 병행)

### Phase 3 — 엔터프라이즈 확장 (요구 발생 시)
6. **D. 인증/IdP** (Cognito 우선, reference-ha 전용)
7. **E. 배포 모드 분리** (control-plane / backend)

### 상시 검토
- **Spot 옵션** Karpenter NodePool 추가 (opt-in)
- **CloudWatch Logs** 관측성 경로 (필요 시)

---

## 5. 설계 시 지켜야 할 osmov2 원칙 (차용 시 가드레일)

toolchain 기능을 이식할 때 osmov2의 핵심 원칙과 충돌하지 않도록 아래를 지킬 것:

1. **재현성 우선**: 모든 신규 외부 의존성은 `versions.yaml`에 핀 고정.
2. **deploy→validate→destroy 단명 워크플로우 보존**: 인증·ESO·보안 서비스는 기본 dev-repro 경로를 무겁게 만들지 않도록 **opt-in**으로 설계.
3. **OSMO 미벤더링**: OSMO 소스/로컬 패치를 넣지 않는다는 원칙 유지 (Helm values로만 구성).
4. **환경 분리**: 무거운 기능은 `reference-ha` 프리셋 전용으로 위치시키고 dev-repro는 최소·저비용 유지.
5. **검증 관행 계승**: 신규 배포 단계마다 `validate-platform.sh`/`validation.md`에 검증 항목 추가.

---

## 부록: 주요 참고 파일 경로

### toolchain (차용 소스)
| 기능 | 파일 |
|------|------|
| pre-commit | `osmo-on-aws/.pre-commit-config.yaml`, `001-iac/.checkov.yaml`, `.tflint.hcl` |
| tfvars 프리셋 | `001-iac/terraform.tfvars.{dev,prod}.example` |
| External Secrets | `002-setup/01-deploy-aws-prerequisites.sh` |
| Keycloak/Cognito | `002-setup/03-deploy-keycloak.sh`, `001-iac/modules/platform/{cognito,identity-center}.tf` |
| 배포 모드 | `docs/deployment-modes.md`, `002-setup/04·05-*.sh` |
| IaC 모듈화 | `001-iac/modules/{platform,eks}/` |
| WAF/보안 | `001-iac/modules/platform/{waf,security,alb-sg}.tf` |
| 로그 집계 | `001-iac/observability.tf` |

### osmov2 (적용 대상)
| 영역 | 파일 |
|------|------|
| 버전 핀 고정 | `versions.yaml` |
| IaC 코어 | `infra/core/{main,variables,outputs}.tf`, `terraform.tfvars.example` |
| 관측성 | `infra/observability/`, `scripts/deploy-observability*.sh` |
| Ingress | `infra/ingress/` |
| 배포 스크립트 | `scripts/deploy-*.sh`, `common.sh` |
| 검증 | `scripts/validate-platform.sh`, `examples/*/validation.md` |
| OSMO 배포 | `scripts/deploy-osmo.sh` |
