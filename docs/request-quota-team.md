# 팀 공유 계정용 Service Quotas 증설 가이드 (10명 동시 사용)

[request-quota.md](./request-quota.md)가 **1인 1계정** 기준이라면, 이 문서는 **하나의 팀
계정에서 10명이 동시에 실습**하는 상황의 증설 가이드입니다. **us-east-1과 us-west-2 두
리전 모두** 신청합니다 — 행사 당일 GPU 용량(ICE)이 리전 단위로 출렁이므로, 두 리전 중
용량이 있는 쪽으로 옮겨갈 수 있어야 합니다 (2026-08-31 실측: us-east-1 전 AZ ICE로
us-west-2 전환).

## 전제와 주의사항

- 이 워크숍의 인프라 코드는 1인 1계정 모델(스택 이름 = 계정 ID)입니다. 팀 계정에서는
  IsaacLab/GrootFinetune/HyperPod 스택이 **계정당 1세트**만 생성되므로:
  - **HyperPod 클러스터는 공유**됩니다 — Slurm이 원래 다중 사용자용이라 자연스럽게 동작
    하지만, GPU 노드 수를 인원만큼 올려야 합니다. 배포 시 그룹당 최대 노드 수 컨텍스트
    (`gpuMaxCount`, 기본 4)를 **10 이상**으로 올려서 배포하세요.
  - **DCV 인스턴스는 1대**만 생성됩니다. 10명이 각자 DCV가 필요하면 추가 인스턴스를
    수동으로 띄워야 하고, 아래 EC2 vCPU 산정은 그 시나리오(10대)를 가정합니다.
  - SageMaker Studio 도메인·ECR·S3 버킷은 공유해도 문제없습니다.
- **큰 값의 증설 요청은 자동 승인되지 않고 검토(케이스)로 넘어갈 수 있습니다.**
  워크숍 목적·기간·리전을 요청 사유에 적고, **최소 1~2주 전에** 신청하세요.
- 계정당 **동시 오픈 SQI 요청 수 한도**가 있으므로(실측 20건, 리전·서비스 구분 없이
  계정 전체 기준), 두 리전 × 여러 항목을 한 번에 넣으면 `QuotaExceededException`이
  납니다. 수동 재실행 대신 [scripts/quota-drip.sh](./scripts/quota-drip.sh)를 백그라운드로
  돌려 두세요 — 10분마다 슬롯을 확인해 빈 만큼 우선순위 순서로 제출하고, 전 항목이
  제출되면 스스로 종료합니다 (멱등, 우선순위: DCV vCPU → SmokeEval GPU → 본 학습 타입 →
  폴백 타입 순).
  - 슬롯을 빨리 비우려면: 콘솔 [Support Center](https://support.console.aws.amazon.com/support/home#/case/history)에서
    더 이상 필요 없는 SQI 케이스를 직접 닫으세요. Support API(`ResolveCase`)는 프리미엄
    서포트 플랜이 없으면 `SubscriptionRequiredException`이 나므로(실측) 콘솔에서만
    가능합니다.

## 산정 원칙

- 동시 사용자 10명 + 재시도/정리(Stopping) 중 겹침 여유 ~20%
- 용량 폴백 시 **전원이 같은 폴백 타입으로 몰릴 수 있으므로** 폴백 타입도 본 타입과
  동일한 수량으로 신청 (실측: g6e/g6이 수 시간 ICE인 동안 전원이 g5로 몰리는 상황 발생 가능)
- **참가자 첫 실행은 최소값으로 안내** — `MaxSteps=100`, `GlobalBatchSize=4`(배치 1까지
  실측 동작)로 파이프라인 완주부터 확인. 이러면 10명이 동시에 돌려도 단일 GPU 소형
  (g6e.2x/4x/8x)으로 분산되어 12xlarge 용량 경쟁이 크게 줄어듭니다.
- **인스턴스 사이즈를 다채롭게 확보** — 리전 용량은 사이즈별로 따로 출렁이고, 12xlarge가
  ICE인 동안에도 단일 GPU 소형이 먼저 잡히는 경향(실측). 사이즈가 다양할수록 10명이
  당일 용량이 있는 타입으로 흩어질 수 있습니다.

## 리전별 신청 목록 (us-east-1, us-west-2 각각 동일하게)

### 1) EC2 — DCV 인스턴스 (모듈 1)

| 쿼터 | 권장값 | 산정 |
|---|---|---|
| Running On-Demand G and VT instances (L-DB2E81BA) | **vCPU 1,280** | 1인 권장 128(최악 48 vCPU 타입 + 재시도 중 잔존 ODCR 겹침) × 10명. AZ 셀렉터 폴백 체인(g6e.4x→g6.4x→g6.12x→g6e.12x)이 어느 타입에 안착할지 배포 시점 용량이 결정하므로 최악 케이스 기준으로 넉넉하게 |

### 2) SageMaker Training (모듈 4)

| 쿼터 | 권장값 | 산정 |
|---|---|---|
| ml.g5.12xlarge for training job usage | **12** | **학습 기본**(4× A10G) — 10명 동시 + 재시도 겹침 여유 |
| ml.g6e.12xlarge for training job usage | 12 (선택) | 더 빠른 학습(4× L40S) — g6e 쿼터를 받을 수 있는 계정만 |
| ml.g6.12xlarge for training job usage | 12 (선택) | 폴백 — 전원이 몰릴 수 있음 |
| ml.g6e.2xlarge for training job usage | **12** | 단일 GPU(1× L40S 48GB) 최소 검증 경로(배치 ≤4, 실측) — 첫 실행은 이쪽으로 유도 |
| ml.g6e.4xlarge for training job usage | **12** | 단일 GPU(48GB) — 사이즈 분산용 |
| ml.g6e.8xlarge for training job usage | **10** | 단일 GPU(48GB) — 사이즈 분산용 |
| ml.m5.2xlarge for processing job usage | **12** | TransformDataset (캐시 히트 시 소모 없음, 최초 실행 대비) |

> ⚠️ 24GB GPU 단일 사이즈(g6/g5의 xlarge~16xlarge)는 신청해도 학습에 못 씁니다 —
> 배치 1에서도 옵티마이저 상태 OOM(실측). 단일 GPU는 g6e(48GB)만, 24GB GPU는
> 12xlarge 멀티 GPU로만 유효합니다.

### 3) SageMaker Processing — SmokeEval (모듈 4) ⚠️

| 쿼터 | 권장값 | 산정 |
|---|---|---|
| ml.g5.2xlarge for processing job usage | **12** | 10명의 SmokeEval 동시 실행 + 여유. GPU 필수 (N1.6은 CPU 불가 — 실측) |
| ml.g6.xlarge for processing job usage | 10 (선택) | 폴백 (`EvalInstanceType` 파라미터) |

### 4) SageMaker HyperPod (모듈 7–9)

| 쿼터 | 권장값 | 산정 |
|---|---|---|
| ml.m5.xlarge for cluster usage | **1** | head 노드 (클러스터 공유, 1대면 충분) |
| ml.g5.12xlarge for cluster usage | **10** | 학습 그룹 `gpu-g5-12x` (기본) — 1인 1노드 동시 학습 |
| ml.g5.8xlarge for cluster usage | **10** | debug 그룹 (모듈 10, 1인 1노드) |
| ml.g6e.12xlarge for cluster usage | 10 (선택) | `-c gpuGroups=extended` 배포 시 `gpu-g6e-12x` |
| ml.g6.12xlarge for cluster usage | 10 (선택) | `-c gpuGroups=extended` 배포 시 `gpu-g6-12x` |

> 클러스터 배포 시 그룹당 최대 노드 수(`gpuMaxCount`, 기본 4)를 10 이상으로 올려야
> 쿼터가 있어도 그룹이 그만큼 확장됩니다.

## 일괄 요청 스크립트 (두 리전)

```bash
REGIONS="us-east-1 us-west-2"

for REGION in $REGIONS; do
  echo "===== $REGION ====="

  request() {  # request <exact-quota-name> <desired>
    local NAME="$1" WANT="$2" CODE CUR
    read -r CODE CUR < <(aws service-quotas list-service-quotas \
      --region "$REGION" --service-code sagemaker --output json \
      | python3 -c "import json,sys
d=json.load(sys.stdin)
for q in d['Quotas']:
    if q['QuotaName'] == '''$NAME''':
        print(q['QuotaCode'], int(q['Value'])); break")
    if [ -z "$CODE" ]; then echo "NOT FOUND: $NAME"; return; fi
    if [ "$CUR" -ge "$WANT" ]; then echo "OK ($CUR): $NAME"; return; fi
    aws service-quotas request-service-quota-increase --region "$REGION" \
      --service-code sagemaker --quota-code "$CODE" --desired-value "$WANT" \
      >/dev/null && echo "REQUESTED $CUR -> $WANT: $NAME" \
      || echo "FAILED (동시 요청 한도 — 기존 요청 처리 후 재실행): $NAME"
  }

  # Training (g5.12x = 기본, g6e/g6.12x = 선택, g6e 2x/4x/8x = 단일 GPU 최소 검증·사이즈 분산)
  request "ml.g5.12xlarge for training job usage" 12
  request "ml.g6e.12xlarge for training job usage" 12
  request "ml.g6.12xlarge for training job usage" 12
  request "ml.g6e.2xlarge for training job usage" 12
  request "ml.g6e.4xlarge for training job usage" 12
  request "ml.g6e.8xlarge for training job usage" 10
  # Processing (Transform + SmokeEval)
  request "ml.m5.2xlarge for processing job usage" 12
  request "ml.g5.2xlarge for processing job usage" 12
  request "ml.g6.xlarge for processing job usage" 10
  # HyperPod cluster (core = g5.12x + g5.8x; g6e/g6는 extended 프로필용)
  request "ml.g5.12xlarge for cluster usage" 10
  request "ml.g5.8xlarge for cluster usage" 10
  request "ml.g6e.12xlarge for cluster usage" 10
  request "ml.g6.12xlarge for cluster usage" 10

  # EC2 G/VT vCPU
  aws service-quotas request-service-quota-increase --region "$REGION" \
    --service-code ec2 --quota-code L-DB2E81BA --desired-value 1280 \
    >/dev/null && echo "REQUESTED: EC2 G/VT vCPU -> 1280" \
    || echo "FAILED: EC2 G/VT vCPU (재시도 필요)"
done
```

## 신청 후 확인

- 진행 상태: `aws service-quotas list-requested-service-quota-change-history --service-code sagemaker --region <region>`
- **적용값 검증**: Service Quotas 표시값이 실제 적용값과 다를 수 있으므로(실측), 행사 전에
  각 축을 실제 API로 프로브하세요 — 방법은 [request-quota.md](./request-quota.md)의
  "적용값 검증" 절 참고.
- 쿼터와 별개로 **리전 GPU 물량(ICE)** 은 당일 변수입니다. 두 리전 모두 승인받아 두고,
  당일 용량이 있는 리전에 배포하는 것이 이 가이드의 목적입니다.
