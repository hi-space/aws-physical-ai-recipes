# GPU 용량과 리전 폴백

기본 GPU 풀은 `g7e-rtx-pro-6000`(RTX PRO 6000, ~96 GB VRAM)입니다. G7e는 신형
인스턴스 패밀리라 리전·가용영역별로 재고 편차가 큽니다. G7e를 못 구할 때 이 리포는
`g6e-l40s`(NVIDIA L40S, 48 GB)로 대신 돌릴 수 있습니다 — L40S는 4개 타깃 리전에서
재고가 넓게 있고 GR00T VLA 파인튜닝과 closed-loop 평가에 충분한 VRAM을 갖췄기에
이를 1순위 대체 GPU로 삼습니다.

> 이 문서는 [gpu-capacity.md](gpu-capacity.md)(영문)의 한국어 번역본입니다.

이것은 운영 가이드입니다: 대체 경로(폴백)는 배포 스크립트에 이미 들어 있습니다
(`DEPLOY_G6E_NODEPOOL` / `OSMO_CONFIGURE_G6E_PLATFORM`). 코드 변경은 필요 없고,
리전별로 g6e를 켜는 방법과 그 판단의 근거가 되는 재고 현황을 기록한 것입니다.

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

## g6e 재고 현황 (2026-07-28 측정)

아래 "g6e AZ" 칸은 그 리전에서 g6e 인스턴스를 실제로 살 수 있는 AZ 목록입니다.
"쿼터"는 한 번에 띄울 수 있는 G 계열 GPU의 vCPU 총량 상한입니다.

| 리전 | g6e를 살 수 있는 AZ | On-Demand G/VT vCPU 쿼터 | g6e 폴백 |
| --- | --- | --- | --- |
| `us-west-2` | a, b, c, d | 768 | 준비됨 |
| `us-east-1` | a, b, c, d | 768 | 준비됨 |
| `ap-northeast-2` | a, b | 768 | 준비됨 |
| `us-east-2` | a, b, c | 64 | 쿼터 증설 필요 |

크기별 g6e vCPU: `2xlarge`=8, `4xlarge`=16, `8xlarge`=32, `12xlarge`=48,
`16xlarge`=64, `24xlarge`=96, `48xlarge`=192. 쿼터 768이면 대략 `g6e.12xlarge`
16대 또는 `g6e.48xlarge` 4대까지 띄울 수 있어 병렬 학습에 넉넉합니다. 반면
`us-east-2`의 쿼터 64는 `g6e.16xlarge` 1대밖에 안 됩니다 — 그 리전에서 g6e를
제대로 된 대체 수단으로 쓰려면 Service Quotas에서 한도 증설(코드 `L-DB2E81BA`,
"Running On-Demand G and VT instances")을 먼저 신청해야 합니다.

e2e 파이프라인 스테이지는 각자의 `cpu`/`memory` 요청에 따라 이 사이즈로
매핑됩니다: RL(02-sim)·closed-loop 평가(04)는 `g6e.4xlarge`, VLA 파인튜닝(03)은
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
osmo workflow submit e2e-pipeline-examples/03-training/workflow.yaml \
  --set platform=g6e-l40s
```

## 리전별로 g6e를 어느 AZ에 둘지

g6e 노드는 한 AZ에 고정(핀)됩니다. 어느 AZ에 둘지는 `KARPENTER_G6E_ZONE`으로
정하고, 따로 지정하지 않으면 그 리전의 첫 번째 AZ(`${AWS_REGION}a`, 즉 이름이 `a`로
끝나는 AZ)로 설정됩니다. 위 표에서 g6e는 4개 리전 모두 `a` AZ에서 팔리므로 기본값
그대로도 동작합니다. `a` AZ에 재고가 없을 때만 아래처럼 다른 AZ로 바꾸면 됩니다.

| 리전 | 기본으로 고정되는 AZ | 대신 쓸 수 있는 AZ |
| --- | --- | --- |
| `us-west-2` | `us-west-2a` | b, c, d |
| `us-east-1` | `us-east-1a` | b, c, d |
| `us-east-2` | `us-east-2a` | b, c |
| `ap-northeast-2` | `ap-northeast-2a` | b뿐 |

```bash
# 예: 기본 AZ(a)에 재고가 없을 때 g6e를 다른 AZ에 두기
KARPENTER_G6E_ZONE=us-west-2c DEPLOY_G6E_NODEPOOL=true \
OSMO_CONFIGURE_G6E_PLATFORM=true scripts/deploy-all.sh
```

`ap-northeast-2`(서울)는 g6e를 파는 AZ가 `a`, `b` 둘뿐이라 4개 리전 중 여유가 가장
적습니다 — 두 AZ 모두 재고가 없으면 그 리전 안에서 더 옮겨갈 세 번째 AZ가 없습니다.

한 가지 더: `infra/core`는 us-east-1의 G7e를 `us-east-1b`/`us-east-1d`에 둡니다
(`a` AZ는 신형 인스턴스에 대해 재고가 잘 안 잡히는 오래된 존이라 뺐습니다). 그래서
g6e 기본값(`us-east-1a`)을 그대로 쓰면 그 리전에서는 g6e가 G7e와 다른 AZ에 뜨게
됩니다. 두 AZ 모두 g6e를 팔기 때문에 노드는 정상적으로 생성되지만, g6e를 G7e와 같은
AZ에 모으고 싶다면 `KARPENTER_G6E_ZONE=us-east-1b`로 지정하세요.

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
