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
