# GPU 용량과 리전 폴백

기본 GPU 풀은 `g7e-rtx-pro-6000`(RTX PRO 6000, ~96 GB VRAM)입니다. G7e는 신형
인스턴스 패밀리라 리전·가용영역별로 재고 편차가 큽니다. G7e를 못 구할 때 이 리포는
`g6e-l40s`(NVIDIA L40S, 48 GB)로 대신 돌릴 수 있습니다 — L40S는 4개 타깃 리전에서
재고가 넓게 있고 GR00T VLA 파인튜닝과 closed-loop 평가에 충분한 VRAM을 갖췄기에
이를 1순위 대체 GPU로 삼습니다. 그 뒤에 세 번째 계층으로 `g6-l4`(NVIDIA L4, 24 GB)가
있습니다. 재고를 구하기는 가장 쉽지만 VLA 파인튜닝에는 용량이 부족합니다.

> 이 문서는 [gpu-capacity.md](gpu-capacity.md)(영문)의 한국어 번역본입니다.

이것은 운영 가이드입니다: 대체 경로(폴백)는 배포 스크립트에 이미 들어 있습니다
(`DEPLOY_G6E_NODEPOOL` / `OSMO_CONFIGURE_G6E_PLATFORM`, L4 계층은
`DEPLOY_G6_NODEPOOL` / `OSMO_CONFIGURE_G6_PLATFORM`). 코드 변경은 필요 없고,
리전별로 폴백을 켜는 방법과 그 판단의 근거가 되는 재고 현황을 기록한 것입니다.

## 먼저, 용어 정리

이 문서에 자주 나오는 세 가지 개념만 짚고 갑니다.

- 리전(region): 오레곤(`us-west-2`), 서울(`ap-northeast-2`)처럼 지리적으로 떨어진
  큰 AWS 지역 단위입니다.
- 가용영역(AZ, availability zone): 한 리전 안에서 물리적으로 분리된 데이터센터
  묶음입니다. 예를 들어 서울 리전에는 `ap-northeast-2a`, `ap-northeast-2b`가
  있습니다. 이름 끝의 `a`/`b`/`c`/`d`가 각각의 AZ입니다.
- AZ 고정(핀, pin): "이 GPU 노드는 반드시 이 AZ 안에서만 띄운다"고 못박는 것입니다.
  원래 Karpenter(GPU 노드를 자동으로 만들어 주는 컴포넌트)는 리전 안의 아무 AZ나
  골라 노드를 띄울 수 있지만, 이 리포는 g6e 노드를 한 AZ에 고정해 둡니다. 같은
  워크로드 노드가 여러 AZ에 흩어지면 AZ 간 전송 요금이 붙고 스토리지(EBS)가 AZ를
  넘나들 수 없기 때문입니다.

## 타깃 리전

레퍼런스는 4개 리전에 배포됩니다: `us-west-2`, `us-east-1`, `us-east-2`,
`ap-northeast-2`. `infra/core`는 4개 모두에 대해 G7e를 어느 AZ에 둘지 미리 정해
둡니다(`infra/core/main.tf`의 `g7e_azs_by_region`).

## 용량 계층: g7e, g6e, g6

GPU 풀은 세 개이고, VRAM이 많은 쪽에서 재고를 구하기 쉬운 쪽으로 내려가는 사다리를
이룹니다. 먼저 워크로드가 요구하는 VRAM으로 고르고, 재고가 막으면 아래로 내려가십시오.

```
계층   플랫폼               GPU                VRAM     용도
g7e    g7e-rtx-pro-6000     RTX PRO 6000       약 96 GB  전체 기본값
g6e    g6e-l40s             L40S               약 45 GB  VLA 파인튜닝, RL, 평가
g6     g6-l4                L4                    24 GB  Isaac Sim 스트리밍, 평가
```

g6가 가장 깊은 계층입니다 — 재고가 남아 있을 확률이 가장 높습니다. 2026-09-15
`us-east-1` 참조 클러스터 관측입니다. 닿을 수 있는 두 AZ에서 g7e 전 크기(2xl~48xl)와
g6e 전 크기(2xl~24xl)가 모두 `InsufficientInstanceCapacity`를 반환하는 상황에서
`g6.2xlarge`는 첫 시도에 떴습니다. 위 두 계층이 전 AZ에서 품절이면 리전을 옮기기 전에
남는 선택지가 g6입니다.

대신 실질적인 한계가 붙습니다. L4의 VRAM은 24 GB로 Isaac Sim 라이브스트림과
closed-loop 평가는 되지만 GR00T VLA 파인튜닝은 안 됩니다. g6는 학습 계층이 아니라
스트리밍·평가 계층으로 쓰십시오. Isaac Sim은 4.5.0과 5.1.0 모두 동작합니다.
2026-09-15 L4에서 실측한 유휴 GPU 메모리는 4.5.0이 577 MiB, 5.1.0이 2032 MiB로,
요구량을 결정하는 것은 시뮬레이터가 아니라 씬입니다. 아래 "최후 계층으로 g6 켜기"
참고.

## g6e 재고 현황 (2026-07-28 측정)

아래 "g6e AZ" 칸은 그 리전에서 g6e 인스턴스를 실제로 살 수 있는 AZ 목록입니다.
"쿼터"는 한 번에 띄울 수 있는 G 계열 GPU의 vCPU 총량 상한입니다.

| 리전 | g6e를 살 수 있는 AZ | On-Demand G/VT vCPU 쿼터 | g6e 폴백 |
| --- | --- | --- | --- |
| `us-west-2` | a, b, c, d | 768 | 준비됨 |
| `us-east-1` | a, b, c, d | 768 | 준비됨 |
| `ap-northeast-2` | a, b | 768 | 준비됨 |
| `us-east-2` | a, b, c | 64 | 쿼터 증설 필요 |

크기별 스펙입니다(`describe-instance-types`로 2026-09-15 확인). 두 계열 모두 위
표의 판매 AZ에서 `48xlarge`까지 전 크기가 제공되며, g7e에는 `16xlarge`가 없습니다.

| 크기 | g6e vCPU / RAM / GPU 개수 | g7e vCPU / RAM / GPU 개수 |
| --- | --- | --- |
| `2xlarge` | 8 / 64 GB / L40S 1 | 8 / 64 GB / RTX PRO 6000 1 |
| `4xlarge` | 16 / 128 GB / L40S 1 | 16 / 128 GB / RTX PRO 6000 1 |
| `8xlarge` | 32 / 256 GB / L40S 1 | 32 / 256 GB / RTX PRO 6000 1 |
| `12xlarge` | 48 / 384 GB / L40S 4 | 48 / 512 GB / RTX PRO 6000 2 |
| `16xlarge` | 64 / 512 GB / L40S 1 | 제공 안 됨 |
| `24xlarge` | 96 / 768 GB / L40S 4 | 96 / 1024 GB / RTX PRO 6000 4 |
| `48xlarge` | 192 / 1536 GB / L40S 8 | 192 / 2048 GB / RTX PRO 6000 8 |

GPU 개수는 vCPU 수에 대해 단조 증가하지 않습니다. `g6e.16xlarge`는 64 vCPU에 GPU 1개,
더 작은 `g6e.12xlarge`는 48 vCPU에 GPU 4개입니다. GPU 연산이 병목인 워크로드는 vCPU가
아니라 GPU 개수를 기준으로 인스턴스 크기를 선택하십시오. GPU 1개로 충분하면
`16xlarge`가 GPU당 vCPU 비율이 가장 높고, 다중 GPU 분산 학습에는 `12xlarge` 이상이
필요합니다. GPU 1개당 VRAM 용량은 계열 내에서 고정이며(L40S 약 45 GB, RTX PRO 6000
약 96 GB) 인스턴스 크기와 무관합니다.

쿼터 768이면 대략 `g6e.12xlarge` 16대 또는 `g6e.48xlarge` 4대까지 띄울 수 있어 병렬
학습에 넉넉합니다. 반면 `us-east-2`의 쿼터 64는 `g6e.16xlarge` 1대밖에 안 됩니다 —
그 리전에서 g6e를 제대로 된 대체 수단으로 쓰려면 Service Quotas에서 한도 증설(코드
`L-DB2E81BA`, "Running On-Demand G and VT instances")을 먼저 신청해야 합니다. 위 표의
쿼터 값은 2026-09-15에 다시 측정했고 변동이 없었습니다.

### NodePool limit도 사용 가능한 크기를 제한합니다

크기 하나가 뜨려면 상한 두 개를 모두 통과해야 합니다.

- 계정의 G/VT vCPU 쿼터(위 표)
- g6e NodePool 자체의 `spec.limits`(`scripts/deploy-karpenter.sh`의
  `KARPENTER_G6E_NODEPOOL_CPU_LIMIT`, `KARPENTER_G6E_NODEPOOL_MEMORY_LIMIT`)

NodePool limit은 용량 오류를 내지 않아서 놓치기 쉽습니다. limit을 넘는 크기는
`KARPENTER_G6E_INSTANCE_TYPES`에 들어 있어도 한 번도 생성되지 않습니다.
2026-09-15 전까지 기본값이 96 vCPU / 768Gi였는데, 이 값은 쿼터가 768 vCPU인
계정에서도 `g6e.48xlarge`(192 vCPU, 1536GB)를 조용히 제외했습니다. 지금 기본값은
192 vCPU / 1536Gi여서 가장 큰 크기까지 쓸 수 있고, g6e 비용을 묶으려면 낮추면
됩니다.

같은 상한이 g7e 풀에도 걸리고, 그쪽은 여전히 유효한 제약입니다.
`KARPENTER_NODEPOOL_CPU_LIMIT` / `KARPENTER_NODEPOOL_MEMORY_LIMIT` 기본값이
120 vCPU / 1200Gi입니다. `g7e.24xlarge`(96 vCPU, 1024GB)는 들어가지만
`g7e.48xlarge`(192 vCPU, 2048GB)는 들어가지 않아서, 쿼터가 허용해도 기본값에서는
가장 큰 g7e 크기에 도달할 수 없습니다. ICE 상황의 탈출구로 쓰려면 두 값을
192 / 2048Gi로 올리십시오. 기본값을 낮게 둔 것은 g7e가 주 풀이고 이 한도가 비용
상한 역할을 겸하기 때문입니다.

특정 크기가 계속 안 뜨면 재고 부족이라고 단정하기 전에 허용 타입과 limit을
먼저 확인하십시오.

```bash
kubectl get nodepool aws-osmo-g6e -o jsonpath='{.spec.template.spec.requirements}'
kubectl get nodepool aws-osmo-g6e -o jsonpath='{.spec.limits}'
```

허용 타입 목록에 없거나 `spec.limits`보다 큰 크기는 재고 문제(ICE)가 아니라 구성
문제입니다. 반대로 실제 원인이 ICE일 때도, ICE는 크기별·AZ별로 발생하므로 크기
목록을 넓히는 것이 노드 하나를 확보할 확률을 가장 싸게 올리는 방법입니다.

e2e 파이프라인 스테이지는 각자의 `cpu`/`memory` 요청에 따라 이 사이즈로
매핑됩니다: RL(02-sim-rl)·closed-loop 평가(04)는 `g6e.4xlarge`, VLA 파인튜닝(03)은
`g6e.8xlarge`, Cosmos 증강(06)은 `g6e.12xlarge`. 단일 스테이지 중 가장 큰 게
`g6e.12xlarge`(48 vCPU)라, `us-east-2`의 64 쿼터로도 파이프라인을 순차로는 돌릴
수 있습니다 — 병렬/동시 실행에만 증설이 필요합니다. 스테이지별 권장 표는
[e2e-pipeline-examples/README.md](../e2e-pipeline-examples/README.ko.md) 참고.

인스턴스 판매 자체는 4개 리전 모두 문제없고, `us-east-2`만 쿼터가 발목을 잡습니다.

## g6e를 폴백으로 켜기

배포할 때 아래 두 스위치를 함께 켜세요 — GPU 노드를 만드는 쪽(Karpenter
NodePool)과 OSMO가 그 노드를 인식하는 쪽(OSMO 플랫폼)을 둘 다 설정해야 합니다.

```bash
# deploy-karpenter.sh: g7e와 함께 g6e 노드 그룹도 생성
DEPLOY_G6E_NODEPOOL=true \
# deploy-osmo.sh: OSMO에 g6e-l40s 플랫폼 등록
OSMO_CONFIGURE_G6E_PLATFORM=true \
  scripts/deploy-all.sh
```

이렇게 하면 워크로드에서 `platform: g6e-l40s`로 지정해 g6e 위에서 돌릴 수 있습니다
(기본값은 `g7e-rtx-pro-6000`). 스테이지 워크플로우는 제출할 때 바꿀 수 있습니다.
예:

```bash
osmo workflow submit e2e-pipeline-examples/03-vla-finetune/workflow.yaml \
  --set platform=g6e-l40s
```

### 이미 배포된 클러스터에 g6e를 추가하기

`scripts/deploy-all.sh`는 신규 배포 경로입니다. 이미 돌고 있는 클러스터라면 전체를
다시 돌릴 필요가 없고, 아래 두 스크립트만 이 순서로 실행하면 됩니다. 두 스크립트는
멱등(idempotent)이라 여러 번 실행해도 안전합니다.

```bash
# 1. Karpenter g6e NodePool 생성. 기존 g7e EC2NodeClass를 재사용하므로
#    AMI·서브넷·보안그룹 설정은 건드리지 않습니다.
DEPLOY_G6E_NODEPOOL=true scripts/deploy-karpenter.sh

# 2. OSMO에 g6e-l40s 플랫폼 등록(pod template + pool config).
OSMO_CONFIGURE_G6E_PLATFORM=true scripts/deploy-osmo.sh
```

순서가 중요합니다. 2단계가 등록하는 플랫폼의 `nodeSelector`가
`karpenter.sh/nodepool=aws-osmo-g6e`를 가리키므로, NodePool이 먼저 있어야 합니다.
없으면 플랫폼이 아무것도 가리키지 않는 상태가 됩니다.

두 단계 모두 추가만 합니다. 1단계는 g7e NodePool을 그대로 두고, 2단계는
`g7e-rtx-pro-6000` 플랫폼을 그대로 둡니다. `g6e-l40s`가 그 옆에 등록될 뿐이고 기본
플랫폼은 바뀌지 않습니다. 지금 g7e에서 돌고 있는 것에는 영향이 없습니다.

각 단계를 넘어가기 전에 확인하십시오.

```bash
# 1단계 후 — NodePool 존재 확인, 그리고 어느 AZ에 고정됐는지 확인
kubectl get nodepool aws-osmo-g6e
kubectl get nodepool aws-osmo-g6e \
  -o jsonpath='{.spec.template.spec.requirements[?(@.key=="topology.kubernetes.io/zone")].values}'

# 2단계 후 — 플랫폼 등록 확인
osmo pool list
```

노드가 실제로 생기기 전까지 `osmo resource list --pool default`에는 g6e 플랫폼이 빈
상태로 보입니다. 정상입니다. Karpenter는 요청이 올 때 노드를 만들기 때문에, 첫 g6e
파드가 스케줄되기 전에는 플랫폼만 등록되고 뒷받침하는 노드가 없습니다. 다만 그
결과로 OSMO는 등록된 노드가 없는 플랫폼에 대한 제출을 거부하므로, 제출 전에 노드를
먼저 확보해야 합니다.

### 워크플로별로 플랫폼을 고르는 방법

워크로드를 g6e로 보내는 방법은 세 가지이고, 어느 것을 쓸지는 워크플로 파일이 어떻게
작성됐는지에 달려 있습니다.

```bash
# 1. platform이 템플릿 변수인 워크플로: 제출할 때 덮어쓰기
osmo workflow submit e2e-pipeline-examples/03-vla-finetune/workflow.yaml \
  --set platform=g6e-l40s

# 2. platform이 고정값인 워크플로: g6e 전용 파일을 제출
osmo workflow submit examples/isaacsim-livestream/workflow-g6e.yaml
```

세 번째는 워크플로의 `resources` 블록에서 `platform:`을 직접 고치는 것입니다. 제출
전에 어느 경우인지 확인하십시오.

```bash
grep -n 'platform:' <workflow.yaml>
```

`platform: g7e-rtx-pro-6000`처럼 값이 그대로 적혀 있으면 고정값이고
`--set platform=`으로는 바뀌지 않습니다. `examples/isaacsim-livestream/`에
`workflow-g6e.yaml`이 따로 있는 이유가 바로 이것입니다. 그리고 이 g6e 변형은
`memory`와 `storage`를 올려 두었습니다. GPU 계열을 바꾸는 것은 플랫폼 이름만 바꾸는
일이 아니기 때문입니다. L40S의 VRAM은 약 45 GB이고 RTX PRO 6000은 약 96 GB이므로,
g7e GPU 1개에 들어갔던 모델이 g6e에서는 다중 GPU 크기를 요구할 수 있습니다(위 사양
표 참고, g6e에서 GPU가 2개 이상인 가장 작은 크기는 `12xlarge`입니다).

### g6e가 해결하는 것과 해결하지 못하는 것

g6e는 시도할 수 있는 크기·AZ 조합을 넓혀 줍니다. 물량을 보장하지는 않고, 리전 전반의
재고 소진에 대한 해법도 아닙니다. 두 풀은 같은 리전 EC2 용량에서 나오므로 동시에
품절일 수 있습니다.

2026-09-15 12:10~12:15 UTC `us-east-1` 참조 클러스터 관측입니다. `aws-osmo-g7e`에
GPU probe를 띄우고 이어서 `aws-osmo-g6e`에 띄웠으나 둘 다 `Pending`에 머물렀습니다.
닿을 수 있는 두 AZ(`us-east-1b`, `us-east-1d`) 모두에서 두 풀의 전 크기가
`InsufficientInstanceCapacity`를 반환했습니다. g7e는 2xl/4xl/8xl/12xl/24xl,
g6e는 2xl/4xl/8xl/12xl/16xl/24xl 전부입니다. g7e에서 g6e로 넘어가도 달라지지
않았습니다. 계열에 국한된 부족이 아니었기 때문입니다.

이 관측에서 에스컬레이션 계획에 반영할 사실이 두 가지 나왔습니다.

첫째, 두 AZ가 동시에 품절이면 AWS의 안내문은 실행 가능한 지침이 아닙니다.
`us-east-1d` 요청에 대한 오류는 `us-east-1b`를 쓰라고 하고, `us-east-1b` 요청에 대한
오류는 `us-east-1d`를 쓰라고 했습니다. 같은 `CreateFleet` 응답 안에서입니다. 이
메시지만 근거로 zone 고정값을 옮기지 말고 probe로 확인하십시오.

둘째, `g7e.48xlarge`는 `g7e_nut_pouring_instance_types`에 들어 있는데도 한 번도
시도되지 않았습니다. Karpenter 로그가 실제로 고려한 후보를 남깁니다.

```
instance-types: "g7e.12xlarge, g7e.24xlarge, g7e.2xlarge, g7e.4xlarge, g7e.8xlarge"
```

가장 큰 크기가 빠진 이유는 192 vCPU가 풀의 기본 한도 120 vCPU를 넘기 때문입니다.
위에서 설명한 NodePool limit 함정이 실제 로그로 드러난 것입니다. `versions.yaml`에
크기를 추가해도 한도가 받아주지 않으면 도달할 수 없습니다.

따라서 재고 부족 상황의 에스컬레이션 순서는 다음과 같습니다.

1. 인스턴스 타입이 아니라 NodePool 단위로 probe해서 Karpenter가 크기를 바꿀 수 있게
   하십시오(`prewarm-gpu-node.sh`는 타입을 하나로 고정하므로 대체가 불가능합니다).
2. g6e보다 g7e를 먼저 probe하십시오. g7e 풀에는 zone 제약이 없어 AZ와 크기를 모두
   바꿀 수 있고, g6e는 한 AZ에 고정되어 크기만 바꿉니다.
3. `KARPENTER_NODEPOOL_CPU_LIMIT` / `KARPENTER_NODEPOOL_MEMORY_LIMIT`을
   192 / 2048Gi로 올려 `g7e.48xlarge`가 실제로 후보에 들어가게 한 뒤
   `scripts/deploy-karpenter.sh`를 다시 실행하십시오. 시도할 크기가 하나 늘어납니다.
4. `KARPENTER_G6E_ZONE`으로 g6e의 zone 고정을 옮기고
   `scripts/deploy-karpenter.sh`를 다시 실행하십시오. 단 프라이빗 서브넷이 있는
   AZ여야 합니다.
5. 닿을 수 있는 모든 AZ에서 두 풀의 전 크기가 품절이면 풀이나 크기를 바꿔도 소용이
   없습니다. 남는 선택지는 기다리기(ICE는 일시적입니다), AWS가 알려준 AZ에 서브넷을
   추가하고 zone 제약을 넓히기, 특정 AZ·타입에 대해 On-Demand Capacity Reservation을
   확보하기, 또는 다른 리전에서 돌리기입니다.

노드를 확보했으면 붙잡아 두십시오. Karpenter는 사용률이 낮은 노드를 정리하므로, 오래
기다려 얻은 노드가 세션을 준비하는 중에 사라질 수 있습니다. 세션 동안 해당 풀의
disruption budget을 잠그고 끝난 뒤 원복하십시오.

```bash
kubectl patch nodepool aws-osmo-g6e --type merge \
  -p '{"spec":{"disruption":{"budgets":[{"nodes":"0"}]}}}'

# 세션 종료 후 원복
kubectl patch nodepool aws-osmo-g6e --type merge \
  -p '{"spec":{"disruption":{"budgets":[{"nodes":"10%"}]}}}'
```

## 최후 계층으로 g6 켜기

g6e와 구조가 같습니다 — Karpenter NodePool과 OSMO 플랫폼을 둘 다 만들어야 합니다.
신규 배포라면:

```bash
# deploy-karpenter.sh: g7e와 함께 g6 노드 그룹도 생성
DEPLOY_G6_NODEPOOL=true \
# deploy-osmo.sh: OSMO에 g6-l4 플랫폼 등록
OSMO_CONFIGURE_G6_PLATFORM=true \
  scripts/deploy-all.sh
```

이미 돌고 있는 클러스터라면 두 스크립트만 이 순서로 실행하십시오. 2단계가 등록하는
플랫폼의 `nodeSelector`가 `karpenter.sh/nodepool=aws-osmo-g6`를 가리키므로 NodePool이
먼저 있어야 합니다.

```bash
DEPLOY_G6_NODEPOOL=true scripts/deploy-karpenter.sh
OSMO_CONFIGURE_G6_PLATFORM=true scripts/deploy-osmo.sh
```

두 단계 모두 추가만 합니다. g7e·g6e 플랫폼과 기본 플랫폼은 그대로입니다. 확인 방법도
g6e와 같습니다.

```bash
kubectl get nodepool aws-osmo-g6
kubectl get nodepool aws-osmo-g6 \
  -o jsonpath='{.spec.template.spec.requirements[?(@.key=="topology.kubernetes.io/zone")].values}'
osmo pool list
```

### g6 풀에 워크로드 제출하기

워크로드는 `platform: g6-l4`로 이 풀을 지정합니다. 어느 방법을 쓸지는 g6e와 똑같이
워크플로 파일이 어떻게 작성됐는지에 달려 있으니 먼저
`grep -n 'platform:' <workflow.yaml>`로 확인하십시오.

```bash
# platform이 템플릿 변수인 워크플로: 제출할 때 덮어쓰기
osmo workflow submit e2e-pipeline-examples/04-closeloop/workflow.yaml \
  --set platform=g6-l4

# platform이 고정값인 워크플로: g6 전용 파일을 제출
osmo workflow submit examples/isaacsim-livestream/workflow-g6.yaml
```

VLA 파인튜닝(`03-vla-finetune`)을 `g6-l4`로 보내지 마십시오. VRAM 24 GB로는 부족하고,
제출 단계에서 걸리는 게 아니라 GPU에서 OOM으로 죽습니다. g6 계층은 Isaac Sim
스트리밍과 closed-loop 평가용입니다. 그리고 g6e와 마찬가지로 OSMO는 등록된 노드가
없는 플랫폼에 대한 제출을 거부하므로 노드를 먼저 확보해야 합니다 — 인스턴스 타입이
아니라 NodePool(`karpenter.sh/nodepool: aws-osmo-g6`)로 probe하십시오
("요청한 크기가 품절일 때 (ICE)" 절 참고).

### 스크립트 기본값은 실제로 성공한 설정보다 좁습니다

`deploy-karpenter.sh`는 g6 NodePool을 한 AZ에 고정하고(`KARPENTER_G6_ZONE`, 기본값은
private 서브넷이 있는 알파벳순 첫 AZ) 풀 상한을 96 vCPU / 768Gi로 둡니다. 이 상한은
`g6_instance_types`의 모든 크기를 허용합니다 — 가장 큰 `g6.24xlarge`가 96 vCPU이므로
여기서 제약이 되는 건 상한이 아니라 zone 고정입니다. 2026-09-15 `us-east-1`에서 실제로
노드를 만들어낸 NodePool에는 zone 요구조건이 아예 없어서 Karpenter가 `us-east-1b`와
`us-east-1d`를 모두 시도할 수 있었습니다. AZ 단위 품절 상황에서는 고정을 옮기십시오.

```bash
KARPENTER_G6_ZONE=us-east-1d DEPLOY_G6_NODEPOOL=true scripts/deploy-karpenter.sh
```

또는 용량을 찾는 동안만 살아 있는 NodePool에서 zone 요구조건을 떼어낼 수도 있습니다.
이렇게 하면 GPU 노드가 나머지 워크로드와 다른 AZ에 뜰 수 있다는 것(AZ 간 전송 요금,
EBS 볼륨은 AZ를 넘지 못함)을 감수하는 것입니다.

```bash
kubectl patch nodepool aws-osmo-g6 --type json \
  -p '[{"op":"remove","path":"/spec/template/spec/requirements/3"}]'
kubectl get nodepool aws-osmo-g6 -o jsonpath='{.spec.template.spec.requirements[*].key}'
```

지우기 전에 인덱스를 확인하십시오. 스크립트가 만든 상태에서는 zone이 네 번째 항목이지만
가정하지 말고 위 `jsonpath`로 확인하십시오.

## 리전별로 g6e를 어느 AZ에 둘지

g6e 노드는 한 AZ에 고정(핀)됩니다. 어느 AZ에 둘지는 `KARPENTER_G6E_ZONE`으로
정합니다. 지정하지 않으면 `deploy-karpenter.sh`가 `infra/core`의
`private_subnet_ids`를 읽어, private 서브넷이 실제로 존재하는 AZ 중 알파벳순으로
첫 번째 AZ에 고정합니다.

이 유도 방식이 중요한 이유는, 그 AZ가 g6e를 팔기만 해서는 안 되고 서브넷이 있어야
하기 때문입니다. 서브넷이 없는 AZ에 고정된 NodePool은 노드를 하나도 만들지 못하는데,
그 실패가 조용합니다. Karpenter는
`skipping, nodepool requirements filtered out all instance types`만 남기고 파드는
`Pending`에 머물며, 원인을 가리키는 용량 오류가 전혀 나오지 않습니다. 2026-09-15에
`us-east-1` 참조 클러스터에서 `us-east-1a`(g6e 7개 크기 전부를 파는 AZ이지만 이 VPC에
서브넷이 없음)에 고정한 NodePool로 재현했고, NodeClaim이 하나도 생성되지 않았습니다.

| 리전 | private 서브넷이 있는 AZ (`infra/core` 기준) | 유도되는 기본값 | 서브넷이 있는 다른 AZ |
| --- | --- | --- | --- |
| `us-west-2` | a, b, c, d | `us-west-2a` | b, c, d |
| `us-east-1` | b, d | `us-east-1b` | d |
| `us-east-2` | a, b | `us-east-2a` | b |
| `ap-northeast-2` | a, b | `ap-northeast-2a` | b |

서브넷 AZ 목록은 `infra/core/main.tf`의 `g7e_azs_by_region`을 `az_count` /
`karpenter_az_count`로 잘라낸 결과입니다. `us-east-1`은 `a` AZ에 서브넷이 없어서 기존
`${AWS_REGION}a` 기본값이 그 리전에서는 쓸 수 없었고, 서브넷 기반 유도가 없앤 문제가
바로 이것입니다. 서브넷이 있는 AZ 밖으로 고정하려면 서브넷을 먼저 추가해야 합니다
(아래 "유연한 probe로도 안 될 때" 참고).

```bash
# 예: 기본 AZ(a)에 재고가 없을 때 g6e를 다른 AZ에 두기
KARPENTER_G6E_ZONE=us-west-2c DEPLOY_G6E_NODEPOOL=true \
OSMO_CONFIGURE_G6E_PLATFORM=true scripts/deploy-all.sh
```

`ap-northeast-2`(서울)는 g6e를 파는 AZ가 `a`, `b` 둘뿐이라 4개 리전 중 여유가 가장
적습니다 — 두 AZ 모두 재고가 없으면 그 리전 안에서 더 옮겨갈 세 번째 AZ가 없습니다.

이 문서의 이전 판에는 `us-east-1`에서 g6e 기본값을 그대로 두면 G7e와 다른 AZ에 뜨지만
"두 AZ 모두 g6e를 팔기 때문에 노드는 정상적으로 생성된다"고 적혀 있었습니다. 그것은
틀린 설명이고, 위 2026-09-15 재현이 정정 근거입니다. `a` AZ 기본값에는 서브넷이 없어서
노드가 아예 생성되지 않았습니다. 인스턴스 타입 판매는 필요조건일 뿐 충분조건이 아니며,
실제 도달 가능성은 서브넷이 결정합니다.

이제 기본값이 서브넷에서 유도되므로 g6e와 G7e는 구조적으로 같은 AZ 집합에 뜨고,
같은 AZ에 모으기 위해 `KARPENTER_G6E_ZONE`을 따로 지정할 필요가 없습니다.

## 배포 전 재고 확인하는 법

```bash
# 타깃 리전에서 g6e를 어느 AZ에 파는지 확인
aws ec2 describe-instance-type-offerings --region "$AWS_REGION" \
  --location-type availability-zone \
  --filters "Name=instance-type,Values=g6e.2xlarge,g6e.4xlarge,g6e.8xlarge,g6e.12xlarge" \
  --query 'InstanceTypeOfferings[].[InstanceType,Location]' --output table

# On-Demand G/VT vCPU 쿼터 확인
aws service-quotas get-service-quota --region "$AWS_REGION" \
  --service-code ec2 --quota-code L-DB2E81BA --query 'Quota.Value' --output text
```

OSMO 검증 전에는 여전히 `scripts/prewarm-gpu-node.sh`로 G7e 용량을 미리 데워
둬야(prewarm) 합니다(e2e 파이프라인 README 참고). g6e 폴백은 그 프리웜이 해당
리전에서 G7e 노드를 띄우지 못할 때 대신 쓰는 길입니다.

단, 위 두 명령으로는 재고 소진을 알 수 없습니다 — 다음 절 참고.

## 요청한 크기가 품절일 때 (ICE)

위 두 확인은 "이 인스턴스 타입을 이 AZ에서 파는가"와 "내 쿼터가 충분한가"에만
답합니다. 둘 다 통과해도 실제 생성은 실패할 수 있습니다. 지금 그 AZ에 그 크기의
여유 용량이 없기 때문이며(`InsufficientInstanceCapacity`, 보통 ICE로 줄여 부름),
ICE는 일시적이고 크기·AZ 단위로 발생합니다. 같은 AZ에서 `g6e.8xlarge`는 안 되는데
`g6e.16xlarge`는 잘 뜨는 식입니다.

2026-08-11 `us-east-1` 클러스터에서 스테이지 README가 안내하는 프리웜을 그대로
실행했을 때 관측된 사례입니다.

```bash
GPU_PREWARM_INSTANCE_TYPE=g6e.8xlarge KARPENTER_NODEPOOL_NAME=aws-osmo-g6e \
  scripts/prewarm-gpu-node.sh
```

파드는 `Pending`에 머물렀고 Karpenter가 `InsufficientCapacityError`를 세 번
기록했습니다: "We currently do not have sufficient g6e.8xlarge capacity in the
Availability Zone you requested (us-east-1b)". 판매 목록에는 us-east-1의 4개 AZ
모두 g6e가 있었고 G/VT 쿼터는 768 vCPU에 실행 중인 G 인스턴스는 0대였으므로,
배포 전 확인 두 가지로는 예측할 수 없었습니다. `aws ec2 run-instances --dry-run`도
소용이 없습니다 — 실제로 품절이던 조합을 포함해 시도한 6개 크기·AZ 조합 전부에
대해 성공을 반환했습니다.

`prewarm-gpu-node.sh`는 이 상황을 스스로 넘기지 못합니다. 프리웜 파드의
`nodeSelector`에 `node.kubernetes.io/instance-type`을 박아두고, 파드가 뜬 노드가
정확히 그 타입인지 검사하기 때문에 Karpenter가 NodePool 목록의 다른 크기로
대체하지 못합니다. 이 고정은 의도된 것입니다 — 특정 타입이 뜬다는 것을 증명하려고
만든 스크립트이기 때문입니다 — 하지만 그 한 크기가 ICE면 프리웜 자체가 막힙니다.

특정 크기가 아니라 "아무 GPU 노드나" 확보하려면, NodePool과 GPU만 요청하고 크기는
Karpenter가 고르게 하면 됩니다.

```bash
NS="$(cd infra/core && terraform output -raw osmo_workload_namespace)"

kubectl -n "$NS" apply -f - <<'YAML'
apiVersion: v1
kind: Pod
metadata:
  name: aws-osmo-gpu-probe
spec:
  restartPolicy: Never
  nodeSelector:
    karpenter.sh/nodepool: aws-osmo-g6e
  tolerations:
    - key: nvidia.com/gpu
      operator: Exists
      effect: NoSchedule
  containers:
    - name: hold
      image: public.ecr.aws/docker/library/busybox:1.36
      command: ["sh", "-c", "sleep 86400"]
      resources:
        limits:
          nvidia.com/gpu: "1"
YAML

kubectl -n "$NS" wait --for=condition=Ready pod/aws-osmo-gpu-probe --timeout=20m
```

위 사례에서 Karpenter는 `us-east-1d`에 `g6e.16xlarge`를 띄웠고, 이후
`osmo resource list --pool default`에 그 노드가 `g6e-l40s` 플랫폼으로 GPU `1/1`로
잡혔습니다 — OSMO가 GPU 워크플로를 받아들이기에 충분합니다. 워크플로를 제출한
뒤에는 프로브 파드를 지우세요. 프로브와 워크플로 파드가 모두 사라지면 Karpenter가
노드를 정리합니다.

한 가지 한계: `deploy-karpenter.sh`는 g6e NodePool을 한 AZ에 고정하므로
(위 `KARPENTER_G6E_ZONE` 참고) 보통 Karpenter는 크기만 바꿀 수 있고 AZ는 바꾸지
못합니다. 위에서 `us-east-1d`까지 갈 수 있었던 건 그 클러스터의 실제 NodePool이
AZ 두 개(`["us-east-1b", "us-east-1d"]`, 해당 리전의 G7e AZ 구성과 동일)를 허용한
상태였기 때문이고, 스크립트는 AZ를 하나만 넣습니다. 스크립트 그대로 만든
NodePool이라면 한 AZ 안에서 크기만 바뀐다고 보면 됩니다. 실제 상태는
`kubectl get nodepool aws-osmo-g6e -o yaml`로 확인하세요. 고정된 AZ에서 모든 g6e
크기가 품절이라면 `KARPENTER_G6E_ZONE`을 다른 AZ로 바꿔
`scripts/deploy-karpenter.sh`를 다시 실행하거나, g7e NodePool로 돌아가세요.

두 풀은 이 점에서 대칭이 아니고, 어느 쪽을 먼저 찔러볼지 고를 때 알아야 합니다. g7e
NodePool에는 `topology.kubernetes.io/zone` 제약이 아예 없어서 Karpenter가 서브넷이 있는
아무 AZ나 쓸 수 있고, 한 AZ에 고정되는 것은 g6e와 g6뿐입니다. 2026-09-15 `us-east-1`
참조 클러스터에서 확인했습니다.

```
g7e requirements: arch, os, capacity-type, instance-type          (zone 없음)
g6e requirements: arch, os, capacity-type, instance-type, zone    (b, d)
```

즉 AZ 단위 재고 소진 상황에서는 폴백 풀이 오히려 더 좁습니다. g7e를 먼저 찔러보면
Karpenter가 AZ를 옮겨 다닐 수 있지만, g6e는 크기만 바꿀 수 있습니다. "g7e가 없으니
g6e로" 하는 통상의 반사와 반대이니, 리전 전체가 품절이라고 결론 내리기 전에 g7e를
AZ 전체에 걸쳐 먼저 시도하십시오.

### 재고 소진과 잘못된 풀 설정을 구분하기

둘 다 파드를 `Pending`으로 남기므로, 용량에 대해 어떤 결론을 내리기 전에 Karpenter
로그 한 줄을 먼저 읽으십시오. 두 경우는 서로 다른 말을 합니다.

```bash
kubectl -n kube-system logs -l app.kubernetes.io/name=karpenter --tail=100 \
  | grep -E 'InsufficientCapacity|UnfulfillableCapacity|filtered out all instance types'
```

| 로그 | 의미 | 해결 |
| --- | --- | --- |
| `skipping, nodepool requirements filtered out all instance types` | 풀 자체의 요구조건을 만족하는 인스턴스 타입이 없음. EC2에 요청조차 나가지 않았습니다. | 구성 문제. zone 고정값을 서브넷 AZ와 맞춰보고, 그다음 `spec.limits`를 크기 목록과 비교하십시오. |
| `CreateFleet`의 `InsufficientCapacityError` / `UnfulfillableCapacity` | EC2에 요청했고 거절당했음. | 실제 재고 소진. 크기를 넓히거나 AZ를 바꾸거나 기다리거나 리전을 바꾸십시오. |

혼란을 주는 쪽은 첫 번째 줄입니다. 스케줄링이 잠깐 어긋난 것처럼 보이고 용량을 전혀
언급하지 않기 때문입니다. 이 줄은 서브넷 없는 AZ에 고정했을 때 나오고, limit을 넘는
크기 목록에서도 나옵니다. 둘 다 ICE가 아닙니다.

### 유연한 probe로도 안 될 때

같은 날 오후(2026-08-11, 13:25 UTC 무렵부터) 그 클러스터에서는 probe도 통하지
않았습니다. 클러스터가 닿을 수 있는 두 AZ에서 두 NodePool의 모든 크기가 품절이었기
때문입니다. Karpenter가 NodeClaim을 만들고 `CreateFleet`에서
`UnfulfillableCapacity`를 받고 삭제하는 약 3분 주기를 반복하며, probe 파드는 45분
넘게 `Pending`이었습니다. g6e에서 g7e로 넘어가도 소용없었고, g7e 다섯 크기 전부
같은 오류였습니다.

AWS 오류 메시지가 용량이 있는 AZ를 알려주는데, 그게 유용한 부분입니다.

```
InsufficientInstanceCapacity: We currently do not have sufficient g6e.8xlarge
capacity in the Availability Zone you requested (us-east-1d). ... You can
currently get g6e.8xlarge capacity by ... choosing us-east-1a, us-east-1b,
us-east-1c.
```

하지만 VPC 서브넷이 `us-east-1b`, `us-east-1d`에만 있어서 그 AZ들로는 갈 수
없었습니다.

```bash
VPC="$(cd infra/core && terraform output -raw vpc_id)"
aws ec2 describe-subnets --filters "Name=vpc-id,Values=$VPC" \
  --query 'Subnets[].{Id:SubnetId,AZ:AvailabilityZone}' --output table
```

즉 닿을 수 있는 모든 AZ에서 두 NodePool이 다 품절이면 크기나 NodePool을 바꿔봐도
소용이 없습니다. 선택지는 ICE가 풀릴 때까지 기다리기(일시적입니다), AWS가 알려준
AZ에 서브넷을 추가하고 NodePool의 zone 제약을 넓히기, 또는 다른 리전에서 돌리기
입니다.

서브넷 추가는 Terraform 변경이 작지만 공짜는 아닙니다. 워크스페이스 tfvars에서
`availability_zones`를 늘리고 `karpenter_az_count`를 4로 올리면
(`terraform.usw2.tfvars`가 이미 쓰는 패턴) 순수 추가로 계획됩니다 — 서브넷 4개와
라우트 테이블 연결 4개, `0 to destroy`, `single_nat_gateway = true`인 동안 NAT
게이트웨이 추가 비용 없음, 신규 private 서브넷은 모듈의 `private_subnet_tags`에서
`karpenter.sh/discovery`를 자동으로 물려받습니다. g7e가 되는 AZ를 목록 앞에
두세요. `az_count`가 앞에서부터 잘라내므로 순서를 바꾸면 EKS와 RDS/Redis 서브넷이
옮겨집니다.

함정은 `terraform apply`가 지난 apply 이후 쌓인 드리프트까지 함께 가져간다는
점입니다. 2026-08-11 클러스터에서는 같은 plan이 RDS `engine_version`을 16.13에서
16.9로 되돌리려 했고(AWS가 마이너 업그레이드를 자동 적용한 상태였습니다) EKS
addon 3개와 Karpenter IAM 2개도 건드리려 했습니다. apply 전에 변경 목록을 전부
확인하고, 서브넷만 원한다면 범위를 좁히세요.

```bash
terraform plan -out=/tmp/az.tfplan
terraform show /tmp/az.tfplan | grep '^  # '   # 모든 줄을 읽으세요
terraform apply -target=module.vpc             # 서브넷만
```

`terraform.tfvars`는 gitignore 대상입니다(배포별 값이 들어갑니다). 따라서
`git checkout`으로는 수정을 되돌릴 수 없고, 직접 손으로 복원해야 합니다.

대상 AZ에 그 타입이 제공되는지부터 확인하세요.

```bash
aws ec2 describe-instance-type-offerings --location-type availability-zone \
  --filters "Name=instance-type,Values=g6e.8xlarge,g6e.12xlarge,g7e.8xlarge" \
  --query 'InstanceTypeOfferings[].{Type:InstanceType,AZ:Location}' --output table
```

지켜보지 않고 기다리려면 GPU 노드가 생겼는지 폴링해서 생긴 뒤에 제출하세요. GPU
노드가 등록되지 않은 상태에서는 OSMO가 제출 자체를 거부합니다(`There are no
resources in platform g6e-l40s and pool default!`). 제출은 노드보다 먼저가 아니라
나중이어야 합니다.
