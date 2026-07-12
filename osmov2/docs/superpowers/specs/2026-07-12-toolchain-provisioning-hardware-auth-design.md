# osmov2 toolchain 차용: 프로비저닝 · 하드웨어 폴백 · 인증 설계

> **상태**: 승인됨 (2026-07-12)
> **출처**: `docs/toolchain-comparison-adoption.md` — `sample-aws-physical-ai-toolchain`에서 차용
> **범위**: (1) GPU 프로비저닝 모드 스위치 + Spot, (2) GPU 폴백 하드웨어 패밀리(G5/A10G, L40S), (3) opt-in 인증(Cognito / IAM Identity Center)

---

## 0. 목표와 가드레일

osmov2의 3가지 운영 확장:

1. **프로비저닝** — 현재 GPU는 Karpenter 전용(on-demand only). 옵션에 따라 **EKS 관리형 노드그룹**도 선택할 수 있는 모드 스위치를 추가하고, capacity type에 **Spot(on-demand+spot 혼합)** 을 opt-in으로 지원.
2. **하드웨어** — g7e(RTX PRO 6000, 주력)를 잡기 어려운 상황을 위해 **G5(A10G)·L40S** 폴백을 추가. 기존 g6/l4 폴백 패턴을 일반화.
3. **인증** — 현재 인증 없음(backend-operator 토큰만). **Cognito / IAM Identity Center** 를 opt-in으로 지원.

### 지켜야 할 osmov2 원칙 (차용 가드레일)

- **재현성 우선**: 신규 외부 의존성은 `versions.yaml`에 핀 고정. capacity type 기본은 on-demand 유지.
- **deploy→validate→destroy 단명 워크플로우 보존**: 인증·Spot·폴백 패밀리는 전부 **opt-in**. 기본 dev-repro 경로는 지금과 동일하게 가볍게 유지.
- **환경 분리**: 무거운 기능(인증)은 `reference-ha` 프리셋 전용.
- **OSMO 미벤더링**: OSMO 소스/로컬 패치 금지. Helm values + `osmo config`로만 구성.
- **검증 관행 계승**: 신규 배포 단계마다 `validate-platform.sh` / `validation.md`에 검증 항목 추가.

### 사용자 결정 사항 (확정)

| 결정 | 선택 |
|------|------|
| 프로비저닝 | GPU 프로비저너 **선택형 모드 스위치** (`karpenter` 기본 / `managed-nodegroup`) |
| 폴백 하드웨어 | **독립 opt-in 패밀리** (g6/l4, g5/a10g, g6e/l40s) |
| 인증 범위 | **opt-in, reference-ha 전용**, Cognito + IAM Identity Center (Keycloak 제외) |
| 인증 깊이 | **전체 경로**: gateway(oauth2Proxy) + upstream TLS + ALB(HTTPS/ACM) 실배 |
| Spot 기본값 | **기본 on-demand, spot opt-in** |

---

## 1. 프로비저닝: GPU 프로비저너 모드 스위치 + Spot

### 1.1 현재 상태

- GPU 용량: `scripts/deploy-karpenter.sh`가 g7e EC2NodeClass + NodePool을 apply. `karpenter.sh/capacity-type: ["on-demand"]` 고정.
- 시스템 노드: `infra/core/main.tf`의 `eks_managed_node_groups.system` (관리형, ON_DEMAND).
- OSMO 플랫폼: `deploy-osmo.sh`가 `platform: g7e-rtx-pro-6000`을 등록. nodeSelector 라벨 키는 이미 `OSMO_GPU_PLATFORM_LABEL_KEY`로 설정 가능(기본 `karpenter.sh/nodepool`).

### 1.2 설계: `GPU_PROVISIONER` 스위치

새 환경변수 `GPU_PROVISIONER=karpenter|managed-nodegroup` (기본 `karpenter`).

- **karpenter** (기본, 변경 없음): 현행 `deploy-karpenter.sh` 경로. 동적·제로스케일·프리워밍 유지.
- **managed-nodegroup** (opt-in): `infra/core/main.tf`에 GPU용 `eks_managed_node_groups` 엔트리를 조건부로 추가 + Cluster Autoscaler 배포. tfvar로 min/desired/max 제어.

### 1.3 핵심 계약: 프로비저너 무관한 OSMO 플랫폼 라벨

두 경로 모두 GPU 노드에 **동일한 라벨 계약**을 스탬프한다:

- `aws.osmo.reference/nodepool=<family>` (예: `g7e`)
- `aws.osmo.reference/gpu-family=<gpu>` (예: `rtx-pro-6000`)

Karpenter NodePool은 이미 이 라벨을 스탬프한다(`deploy-karpenter.sh` L131-133). 관리형 노드그룹은 `labels`로 동일하게 스탬프한다.

- **karpenter 모드**: OSMO 플랫폼 nodeSelector 키 = `karpenter.sh/nodepool`, 값 = NodePool 이름 (현행 유지).
- **managed-nodegroup 모드**: nodeSelector 키 = `aws.osmo.reference/nodepool`, 값 = family 이름. `OSMO_GPU_PLATFORM_LABEL_KEY`/`_VALUE`가 이미 파라미터라 배포 스크립트에서 모드에 따라 값만 바꾼다.

결과: 워크로드 매니페스트(`platform: g7e-rtx-pro-6000`)는 프로비저너와 무관하게 동일.

### 1.4 Spot capacity type

- **Karpenter 경로**: `KARPENTER_CAPACITY_TYPE` (기본 `on-demand`, opt-in `on-demand,spot`). NodePool `karpenter.sh/capacity-type` requirement의 `values`에 CSV→YAML 리스트로 주입. 혼합 시 Karpenter가 spot 우선, 없으면 on-demand.
- **managed-nodegroup 경로**: `gpu_capacity_type` tfvar (`ON_DEMAND` 기본 / `SPOT`). 관리형 노드그룹은 단일 capacity_type만 지원하므로 혼합은 Karpenter 경로에서만.
- **기본값**: on-demand. 재현성 벤치마크에 영향 없음. Spot 중단이 재현성에 영향 → 명시적 opt-in만.

### 1.5 변경 파일

| 파일 | 변경 |
|------|------|
| `infra/core/variables.tf` | `gpu_provisioner`, `gpu_managed_node_*` (min/desired/max/instance_types), `gpu_capacity_type` 추가 |
| `infra/core/main.tf` | 조건부 GPU `eks_managed_node_groups` 엔트리 (managed 모드) |
| `scripts/deploy-karpenter.sh` | `KARPENTER_CAPACITY_TYPE` 주입; `GPU_PROVISIONER!=karpenter`면 스킵 |
| `scripts/deploy-infra.sh` (또는 신규 `deploy-cluster-autoscaler.sh`) | managed 모드에서 Cluster Autoscaler 배포 |
| `scripts/deploy-osmo.sh` | 모드에 따라 `OSMO_GPU_PLATFORM_LABEL_KEY/_VALUE` 결정 |
| `versions.yaml` | Cluster Autoscaler 차트/버전 핀 고정 (managed 모드용) |

---

## 2. 하드웨어: GPU 폴백 패밀리 레지스트리

### 2.1 현재 상태

`deploy-karpenter.sh`와 `deploy-osmo.sh`에 **g6/l4 폴백이 하드코딩된 단일 블록**으로 존재(opt-in `DEPLOY_G6_NODEPOOL` / `OSMO_CONFIGURE_G6_PLATFORM`). NodePool + OSMO 플랫폼(`g6-l4`)을 이룬다. 패밀리를 추가하려면 이 블록을 통째로 복붙해야 함 → G5+L40S 추가 시 3배로 늘어남.

### 2.2 설계: 패밀리 레지스트리로 일반화

각 폴백 패밀리는 동일한 3요소를 가진 **선언적 항목**:

1. `versions.yaml` instance-type 리스트
2. Karpenter NodePool(또는 managed 노드그룹) — 라벨 `aws.osmo.reference/nodepool=<family>` + `gpu-family=<gpu>`
3. OSMO 플랫폼 — 파라미터화된 pod-template + pool config 블록

`GPU_FALLBACK_FAMILIES` 환경변수(CSV, 기본 빈 값)로 활성화. 각 패밀리는 이름/instance-types/gpu-label/zone을 선언.

| family | GPU | OSMO 플랫폼 | instance types (versions.yaml) |
|--------|-----|-------------|-------------------------------|
| `g6` | L4 (24GB) | `g6-l4` | `g6.2xlarge,g6.4xlarge,g6.8xlarge` (기존) |
| `g5` | A10G (24GB) | `g5-a10g` | `g5.2xlarge,g5.4xlarge,g5.8xlarge` |
| `g6e` | **L40S (48GB)** | `g6e-l40s` | `g6e.2xlarge,g6e.4xlarge,g6e.8xlarge` |

> **L40S = `g6e` 인스턴스 패밀리** (48GB). G5 = A10G (24GB). 확정됨.

### 2.3 리팩터링 방향

`deploy-karpenter.sh`의 g6 블록과 `deploy-osmo.sh`의 g6 플랫폼 블록을 **패밀리 리스트를 순회하는 함수**로 추출. 각 패밀리는 (name, instance_types, gpu_family_label, zone)을 인자로 받아 NodePool/플랫폼을 생성. 기존 g6 동작은 이 일반화의 첫 번째 인스턴스로 흡수(회귀 없이).

- AZ 핀은 패밀리별 설정(현행 g6 단일-AZ 방식 계승). 기본은 g7e AZ 전략과 정렬.
- managed-nodegroup 모드에서는 폴백 패밀리도 관리형 노드그룹으로 생성(같은 라벨 계약).

### 2.4 변경 파일

| 파일 | 변경 |
|------|------|
| `versions.yaml` | `g5_instance_types`, `g6e_l40s_instance_types` 추가; 패밀리별 nodepool/platform 이름 |
| `scripts/deploy-karpenter.sh` | g6 블록 → 패밀리 순회 함수로 추출; `GPU_FALLBACK_FAMILIES` 소비 |
| `scripts/deploy-osmo.sh` | g6 플랫폼 블록 → 패밀리 순회 함수로 추출 |
| `infra/core/*` (managed 모드) | 패밀리별 조건부 GPU 노드그룹 |

---

## 3. 인증: Cognito / IAM Identity Center (opt-in, reference-ha 전용)

### 3.1 현재 상태

- 인증 없음. OSMO `backend-operator` 토큰만(`deploy-osmo.sh` L531+).
- `gateway.oauth2Proxy.enabled=false`, `gateway.tls.enabled=false`. 내부 nginx 라우터가 경로 라우팅(`/api/logger/*`→logger, `/*`→service), 접근은 port-forward.
- `infra/ingress` 모듈은 이미 ALB + ACM + Route53 + CIDR allow-list 지원.

### 3.2 설계: opt-in `infra/auth/` 모듈 + `scripts/deploy-auth.sh`

기본 off. `reference-ha` 환경에서만 활성. `auth_provider = cognito | identity-center` (Keycloak 제외).

**IdP 프로비저닝 (`infra/auth/`)**:

- **cognito**: user pool + app client(browser flow + device flow) + groups(OSMO 역할 매핑). 관리형이라 운영 부담 낮음 → 권장 기본.
- **identity-center**: customer-managed OAuth2 application, authorization_code grant, redirect URIs, IAM auth method. **client_secret은 `terraform apply` 후 Identity Center 콘솔에서 수동 생성** 필요(toolchain 동일 제약, 문서 명시).
- 두 provider 모두 OIDC **issuer URL / clientID / jwks** 출력.

**OSMO 연동 (전체 경로)** — `deploy-osmo.sh`가 인증 활성 시:

1. `gateway.oauth2Proxy.enabled=true`, `provider=oidc`, `oidcIssuerUrl`/`clientId`/`cookieDomain`을 `--set`으로 주입 (toolchain `osmo-control-plane.yaml` 패턴).
2. `gateway.tls.enabled=true` — upstream TLS 활성.
3. `auth.external_roles` 매핑 선언: `osmo-admin` / `osmo-user` / `osmo-ctrl` / `osmo-backend`.
4. **진입점 전환**: 내부 nginx router + port-forward → `infra/ingress` ALB(HTTPS/ACM/Route53)가 진입점.

### 3.3 가드레일: dev-repro 불변

- dev-repro는 지금과 동일: gateway-disabled + nginx router + port-forward + backend-operator 토큰. 인증 코드 경로는 절대 건드리지 않음.
- 인증은 독립 배포 스테이지(`deploy-auth.sh`)로, 요청 시에만 레이어링.
- gateway/TLS/ALB 전환은 인증 활성 시에만. → 검증 매트릭스에 별도 항목 추가(reference-ha + auth).

### 3.4 변경 파일

| 파일 | 변경 |
|------|------|
| `infra/auth/` (신규) | `main.tf` (cognito.tf / identity-center.tf 분리), `variables.tf`, `outputs.tf`, `terraform.tfvars.example`, `README.md` |
| `scripts/deploy-auth.sh` (신규) | IdP 배포 + OIDC 출력 수집 |
| `scripts/deploy-osmo.sh` | 인증 활성 시 oauth2Proxy/TLS/external_roles values + ingress 진입점 |
| `infra/ingress/` | (기존 그대로 사용; 인증 진입점으로 문서화) |
| `versions.yaml` | oauth2-proxy 등 신규 의존성 핀 고정 |

---

## 4. 통합 배포 흐름 (요약)

```
dev-repro (기본, 변경 없음):
  deploy-infra → deploy-karpenter (karpenter, on-demand) → deploy-gpu-operator/kai/efa
  → deploy-osmo (gateway off, nginx router, backend-operator 토큰) → port-forward

reference-ha + 확장 (opt-in):
  deploy-infra (GPU_PROVISIONER 선택)
  → [karpenter] deploy-karpenter (KARPENTER_CAPACITY_TYPE, GPU_FALLBACK_FAMILIES)
     [managed]  Cluster Autoscaler + 관리형 GPU 노드그룹
  → deploy-auth (cognito | identity-center)          # opt-in
  → deploy-ingress (ALB/ACM/Route53)                 # 인증 진입점
  → deploy-osmo (oauth2Proxy + TLS + external_roles, 폴백 패밀리 플랫폼 등록)
```

---

## 5. 검증 계획

- **프로비저닝**: karpenter 모드(현행) 회귀 + managed 모드 신규 — GPU pod 스케줄 확인, OSMO 플랫폼 라벨 매칭 확인. Spot 활성 시 NodePool requirement 확인.
- **하드웨어**: 각 폴백 패밀리(g6/g5/g6e) 활성 → NodePool Ready + OSMO 플랫폼 등록 + 해당 `platform:`으로 워크로드 스케줄. 기존 g6 회귀 필수.
- **인증**: reference-ha + cognito → oauth2Proxy 로그인 플로우(browser + device), external_roles 매핑 확인, ALB HTTPS 진입 확인. identity-center → 수동 client_secret 단계 문서대로 동작.
- `scripts/validate-platform.sh`에 모드/패밀리/인증 조건부 검증 추가. `examples/*/validation.md` 관행 계승.

---

## 6. 명시적 비목표 (YAGNI)

- Keycloak 지원 (Cognito/IdC로 충분).
- managed-nodegroup 모드에서 EFA 멀티노드 (Karpenter 경로에서만 검증됨 — 문서에 명시).
- 배포 모드 분리(control-plane/backend) — 별도 스펙.
- 순서형 폴백 체인 (독립 패밀리 방식 채택).
