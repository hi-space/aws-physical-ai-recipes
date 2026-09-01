# 워크숍 사전 Service Quotas 증설 가이드 (request-quota)

Physical AI on AWS 워크숍(e2e-workshop + hyperpod-training)을 새 계정에서 돌리기 전에
증설해야 하는 서비스 쿼터 목록입니다. **2026-09-01 신규 계정(us-west-2)에서 전 모듈을
실제 실행하며 실측한 결과**를 기준으로 작성했습니다.

## 꼭 알아야 할 것 3가지 (실측)

1. **SageMaker 쿼터는 용도별로 3개 축이 완전히 분리되어 있습니다.** 같은 인스턴스 타입이라도
   `for training job usage`(학습), `for processing job usage`(SmokeEval 등 Processing Job),
   `for cluster usage`(HyperPod)가 **각각 별도 쿼터**입니다. 예: training 쿼터가 1이어도
   processing 쿼터가 0이면 파이프라인이 SmokeEval에서 `ResourceLimitExceeded`로 실패합니다.
2. **Service Quotas 콘솔의 표시값과 실제 적용값이 다를 수 있습니다.** 콘솔에 2로 보여도
   실제 CreateProcessingJob이 "limit is 0 Instances"로 거부된 사례가 있습니다. 확실한 확인
   방법은 해당 API를 직접 호출해 보는 것입니다 (아래 검증 스크립트 참고).
3. **계정당 동시 오픈 가능한 증설 요청(SQI) 수에 한도가 있습니다.** 한 번에 전부 요청하면
   `QuotaExceededException`이 나므로, 소액 요청부터 나눠서 넣으세요. 소액(1~3) 요청은
   약 30분 내 자동 승인되는 것을 관찰했습니다. 큰 값은 검토가 걸릴 수 있으니 **워크숍
   최소 1주 전에** 신청하세요.

## 태스크별 필요 쿼터

리전: 워크숍을 배포할 리전 기준 (실측 검증: us-west-2. us-east-1은 기본값이 후한 편이지만
계정마다 다르므로 반드시 확인).

### 1) 모듈 1 — IsaacLab DCV 인스턴스 (EC2) — **넉넉하게 신청하세요**

| 쿼터 이름 (Service Quotas) | 서비스 | 권장값 | 용도 |
|---|---|---|---|
| Running On-Demand G and VT instances (L-DB2E81BA) | Amazon EC2 | **vCPU 128** | DCV GPU 인스턴스 + AZ 셀렉터 폴백 여유분 |

**왜 128 vCPU인가 (넉넉하게 잡아야 하는 이유):**

- DCV 인스턴스는 고정 타입이 아닙니다. AZ 셀렉터가 리전 용량에 따라
  **g6e.4xlarge(16 vCPU) → g6.4xlarge(16) → g6.12xlarge(48) → g6e.12xlarge(48)**
  순으로 폴백하므로, 어떤 타입에 안착할지는 배포 시점의 GPU 용량이 결정합니다.
  최악 케이스만 해도 48 vCPU입니다.
- AZ 셀렉터가 용량을 붙잡아 두는 **온디맨드 용량 예약(ODCR)도 같은 vCPU 한도에
  계산**됩니다. 배포 실패 후 재시도 시 이전 예약(3시간 한정)이 아직 만료되지 않은
  상태에서 새 예약 + 새 인스턴스가 겹치면 순간적으로 2배까지 점유될 수 있습니다.
- 여유가 없으면 GPU 용량이 있어도 **vCPU 한도에서 `VcpuLimitExceeded`로 배포가
  실패**합니다 — GPU 부족(ICE)과 달리 폴백으로도 못 피하는 하드 블록입니다.

산정: 최악 인스턴스 48 vCPU × (인스턴스 + 재시도 중 잔존 ODCR) 2 = 96 → 여유 포함 **128**.
기본값(계정에 따라 0~64)은 대부분 부족하므로 반드시 확인 후 증설하세요.

### 2) 모듈 4 — SageMaker 파이프라인 학습 (training job usage)

**원칙: 첫 실행은 항상 최소값으로.** `MaxSteps=100`, `GlobalBatchSize=4`(배치 1까지 동작 —
실측)로 다섯 스텝이 끝까지 도는지부터 확인하세요. 이 설정이면 **단일 GPU 48GB급 쿼터
1개만으로도 전체 파이프라인 검증이 가능**하고, 실행 시간·비용·용량 요구가 모두 최소가
됩니다. 본격 학습(배치 32, 6000 스텝)은 그 다음에 12xlarge급으로 올리세요.

**여러 사이즈를 골고루 증설해 두세요.** 리전 GPU 용량은 타입·사이즈별로 따로 출렁이며,
12xlarge가 몇 시간씩 ICE인 동안에도 단일 GPU 소형(2x/4x/8x)은 먼저 잡히는 경향이
있었습니다(실측). 파이프라인의 `InstanceType`은 런타임 파라미터라 쿼터만 있으면 재업서트
없이 바로 갈아탈 수 있습니다.

| 쿼터 이름 | 권장값 | 용도 |
|---|---|---|
| ml.g6e.12xlarge for training job usage | **2** | 본격 학습 기본 (4× L40S, 배치 32) |
| ml.g6.12xlarge for training job usage | **2** | 용량 부족 시 폴백 (4× L4, DeepSpeed로 통과 가능) |
| ml.g5.12xlarge for training job usage | **2** | 용량 부족 시 폴백 (4× A10G) |
| ml.g6e.2xlarge for training job usage | **1–2** | 단일 GPU(1× L40S 48GB) 최소 검증 경로 — 배치 1~4 실측 통과 |
| ml.g6e.4xlarge for training job usage | **1–2** | 단일 GPU(48GB), CPU/RAM 여유 |
| ml.g6e.8xlarge for training job usage | **1** | 단일 GPU(48GB), 2x/4x 용량 부족 시 대체 |
| ml.m5.2xlarge for processing job usage | 기본값(≥1) 확인 | TransformDataset 단계 (Processing Job) |

> 권장값 2인 이유: 직전 실행이 정리(Stopping)되는 동안 재실행하면 1로는 충돌합니다
> (파이프라인에 백오프 재시도가 들어있지만 2면 대기가 없어짐).
>
> ⚠️ **24GB GPU 단일 사이즈는 신청해도 학습에 못 씁니다** — g6/g5의 xlarge~16xlarge
> (1× L4/A10G 24GB)는 배치를 1로 줄여도 옵티마이저 상태 할당에서 OOM입니다(실측,
> 배치와 무관). 단일 GPU는 반드시 48GB급(g6e), 24GB GPU는 12xlarge 멀티 GPU
> (DeepSpeed 분산)로만 사용하세요.

### 3) 모듈 4 — SmokeEval (processing job usage) ⚠️ 가장 자주 빠뜨리는 축

| 쿼터 이름 | 권장값 | 용도 |
|---|---|---|
| ml.g6.xlarge for processing job usage | **2** | SmokeEval 기본 인스턴스. **GPU 필수** — GR00T N1.6 백본이 flash attention을 코드에서 강제하므로 CPU 인스턴스로는 평가가 불가능합니다 (실측) |
| ml.g6.2xlarge for processing job usage | 1 (선택) | 폴백 (파이프라인 `EvalInstanceType` 파라미터로 전환) |

### 4) 모듈 7–9 — HyperPod 클러스터 (cluster usage)

| 쿼터 이름 | 권장값 | 용도 |
|---|---|---|
| ml.m5.xlarge for cluster usage | 1 (기본값 확인) | head 노드 (Slurm controller) |
| ml.g6e.12xlarge for cluster usage | **1–2** | 학습 그룹 `gpu-g6e-12x` (문서 기본) |
| ml.g5.12xlarge for cluster usage | **1** | 폴백 그룹 `gpu-g5-12x` — g6e/g6가 리전 용량 부족(ICE)일 때 실질적 탈출구 (실측: g6e/g6가 수 시간 ICE인 동안 g5만 잡힘) |
| ml.g6.12xlarge for cluster usage | 1 (선택) | 폴백 그룹 `gpu-g6-12x` |
| ml.g6e.4xlarge for cluster usage | **1** | `debug` 그룹 (모듈 9 DCV 시각 검증) |

## 일괄 요청 스크립트

```bash
REGION=us-west-2   # 워크숍 리전으로 변경

request() {  # request <quota-name-substring> <desired>
  local NAME="$1" WANT="$2"
  local CODE CUR
  read -r CODE CUR < <(aws service-quotas list-service-quotas \
    --region "$REGION" --service-code sagemaker --output json \
    | python3 -c "import json,sys;
d=json.load(sys.stdin)
for q in d['Quotas']:
    if q['QuotaName'] == '''$NAME''':
        print(q['QuotaCode'], int(q['Value'])); break")
  if [ -z "$CODE" ]; then echo "NOT FOUND: $NAME"; return; fi
  if [ "$CUR" -ge "$WANT" ]; then echo "OK ($CUR): $NAME"; return; fi
  aws service-quotas request-service-quota-increase --region "$REGION" \
    --service-code sagemaker --quota-code "$CODE" --desired-value "$WANT" \
    >/dev/null && echo "REQUESTED $CUR -> $WANT: $NAME" \
    || echo "FAILED (동시 요청 한도일 수 있음 — 나중에 재시도): $NAME"
}

# training (12x = 본격 학습, 2x/4x/8x = 단일 GPU 최소 검증·폴백)
request "ml.g6e.12xlarge for training job usage" 2
request "ml.g6.12xlarge for training job usage" 2
request "ml.g5.12xlarge for training job usage" 2
request "ml.g6e.2xlarge for training job usage" 2
request "ml.g6e.4xlarge for training job usage" 2
request "ml.g6e.8xlarge for training job usage" 1
# processing (SmokeEval)
request "ml.g6.xlarge for processing job usage" 2
# HyperPod cluster
request "ml.g6e.12xlarge for cluster usage" 2
request "ml.g5.12xlarge for cluster usage" 1
request "ml.g6.12xlarge for cluster usage" 1
request "ml.g6e.4xlarge for cluster usage" 1
```

EC2 vCPU 쿼터(G/VT)는 서비스 코드가 다릅니다:

```bash
aws service-quotas request-service-quota-increase --region "$REGION" \
  --service-code ec2 --quota-code L-DB2E81BA --desired-value 128   # G/VT vCPU (넉넉하게)
```

## 적용값 검증 (표시값을 믿지 말 것)

Processing 쿼터가 실제로 적용됐는지는 CreateProcessingJob을 직접 호출해 확인합니다
(생성되면 즉시 stop — 과금 수 센트 이내):

```bash
NAME="quota-probe-$(date +%s)"
aws sagemaker create-processing-job --region "$REGION" \
  --processing-job-name "$NAME" \
  --role-arn <SageMaker 실행 롤 ARN> \
  --app-specification '{"ImageUri":"<아무 ECR 이미지>","ContainerEntrypoint":["python3","-c","print(1)"]}' \
  --processing-resources '{"ClusterConfig":{"InstanceCount":1,"InstanceType":"ml.g6.xlarge","VolumeSizeInGB":30}}' \
  && aws sagemaker stop-processing-job --region "$REGION" --processing-job-name "$NAME"
# ResourceLimitExceeded 가 나오면 아직 적용 전
```

## 리전 용량(capacity)은 쿼터와 별개입니다

쿼터가 있어도 리전에 물리 GPU가 없으면 `InsufficientInstanceCapacity`(EC2/HyperPod) 또는
학습 Job의 "waiting for capacity"로 대기합니다. 대응책:

- 파이프라인: `InstanceType` 파라미터로 g6e.12x ↔ g6.12x ↔ g5.12x 전환 (재시도 정책 내장)
- HyperPod: `scale-cluster.sh`가 롤백을 감지하고 종료하므로, 다른 그룹(`gpu-g5-12x` 등)으로
  재시도. 단일 GPU 소형(g6e.2x/4x/8x)이 12xlarge보다 먼저 잡히는 경향 (실측)
- EC2(DCV): AZ 셀렉터가 자동으로 타입/AZ를 폴백하고 ODCR로 용량을 예약
