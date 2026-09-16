# Physical AI 대시보드 추가 비용 모델

상태: 설계 검토용. 리소스 생성 전 추정치이며 전체 AWS 청구서가 아니다.

조회일 `2026-09-16`, 리전 `us-east-1`, 통화 USD, On Demand, 730시간/월.

## 조회 결과와 산식

| 서비스 | 단가 | 가정 | 월 비용 |
|---|---:|---|---:|
| Fargate Linux x86 CPU | $0.04048 / vCPU-hour | 1.25 vCPU × 730h | $36.9380 |
| Fargate memory | $0.004445 / GB-hour | 2.5 GB × 730h | $8.1121 |
| ALB | $0.0225 / hour | 1 × 730h | $16.4250 |
| ALB 사용 LCU | $0.008 / LCU-hour | 평균 1 × 730h | $5.8400 |
| 사용 중 공인 IPv4 | $0.005 / address-hour | 2 × 730h | $7.3000 |
| **모델링한 상시 계층 합계** | | | **$74.6151 ≈ $74.62** |

서비스별 task는 web 0.5 vCPU/1 GiB, controller 0.5 vCPU/1 GiB, session gateway 0.25 vCPU/0.5 GiB, 각 1개다. 고가용성 구성이나 많은 동시 접속을 수용하는 규모를 가정하지 않는다.

GPU 추가 실행:

| 리소스 | API에서 확인한 usage type | 단가 |
|---|---|---:|
| HyperPod `ml.g5.8xlarge` | `USE1-Cluster:ml.g5.8xlarge` | $3.06 / node-hour |
| EC2 `g5.4xlarge` Linux shared | `BoxUsage:g5.4xlarge` | $1.624 / instance-hour |

예를 들어 검증을 위해 HyperPod GPU 2대를 1.5시간 추가하면 `2 × 1.5 × 3.06 = $9.18`의 GPU compute 비용이다. 데이터 준비, 이미지 pull, 초기화와 종료까지의 시간도 실제 청구 시간에 영향을 준다. 예시는 상한이 아니다.

## 포함하지 않은 비용

- 현재 계정에서 이미 운영 중인 EKS control plane, HyperPod CPU, FSx, NAT Gateway, DCV 워크스테이션, AMP, MLflow.
- 새 대시보드의 S3 용량·요청·전송, DynamoDB 저장·읽기·쓰기, SQS, Step Functions, 필요한 Lambda 실행.
- Cognito 월 활성 사용자와 인증 부가 기능, CloudWatch 로그·지표, ECR 저장·스캔, CodeBuild.
- DNS 쿼리, Secrets Manager, KMS 사용, EFS 선택 시 저장 및 throughput.
- 인터넷 및 AZ 간 data transfer, NAT 처리량, 증가한 ALB LCU와 공인 IP.
- SageMaker 학습·평가 작업, 별도 H100급 profile, 실물 edge 장치.
- 추가 replica·autoscaling, 백업·운영 고가용성, 할인·Free Tier·세금.

따라서 `$74.62/월`을 “전체 플랫폼 운영비”로 표시하지 않는다. UI도 고정 계층 추정, 실행별 예상 GPU 비용, 실제 사용량 데이터를 구분해야 한다.

## 데이터 provenance와 조회 방법

1. `awspricing` MCP 도구를 discovery했다. 일부 exact-name 검색에서 관련 도구만 반환되어 AWS CLI Price List API로 먼저 단가와 정확한 attribute 값을 조회했다.
2. 이후 노출된 `awspricing.get_pricing`으로 Fargate CPU/memory와 Application Load Balancer/LCU 단가를 확인했다.
3. `aws pricing get-products`로 공인 IPv4, HyperPod cluster, EC2 단가를 조회했다.
4. `awspricing.generate_cost_report` 실행을 시도했으나 도구가 `Error executing tool generate_cost_report`를 반환했다. 따라서 조회한 단가로 이 메모의 산식을 직접 작성했다.

확인한 catalog 식별자:

| 항목 | SKU | catalog publication |
|---|---|---|
| Fargate CPU | `8CESGAFWKAJ98PME` | 2026-09-11 |
| Fargate memory | `PBZNQUSEXZUC34C9` | 2026-09-11 |
| ALB hour | `37CUWUT8GSNQEPUV` | 2026-09-11 |
| ALB LCU | `P2XGEJ8N3KU52WA8` | 2026-09-11 |
| HyperPod `ml.g5.8xlarge` | `YQXD4PZ3BTQ5N2P4` | 2026-09-15 |

처음 ALB 조회의 `productFamily=Load Balancer`는 Classic Load Balancer 결과였으므로 계산에서 제외했다. `Load Balancer-Application`으로 다시 조회했다.

처음 SageMaker 조회의 `instanceType=ml.g5.8xlarge`는 Studio 결과였으므로 HyperPod 가격 근거로 사용하지 않았다. attribute 조회 후 `ml.g5.8xlarge-Cluster`, usage type `USE1-Cluster:ml.g5.8xlarge`를 선택했다. 이름에 `Reserved`가 붙은 별도 SKU도 계산에서 제외했다.

## 운영 시 적용

- 기존 VPC·NAT·FSx·AMP·MLflow를 명시적으로 import한다.
- 실험에 가격 조회 시각·region·instance type·GPU-hours 추정을 기록한다.
- 테스트 전 GPU baseline을 저장하고 해당 테스트가 추가한 capacity만 회수한다.
- interactive session TTL과 사용자에게 보이는 연장 기능을 제공한다.
- 로그 보존 기간, artifact lifecycle, metrics query 범위를 설정한다.
- 사용자 작업이 실행 중인 노드는 자동 scale-down 대상에서 제외하고 동시 capacity 변경을 재확인한다.
