# HyperPod 분산 학습 인프라 — 실습 가이드

AWS SageMaker HyperPod 기반 Physical AI (VLA/RL) 분산 학습 환경을 배포하고, 데이터 준비부터 학습 실행, MLflow 모니터링까지 전체 파이프라인을 실습합니다.

> 이 문서는 [README.md](README.md)(영문)의 한국어 번역본입니다. 상세 원문은 영문 README를 기준으로 삼으세요.

## 아키텍처 요약

```
┌───────────────────────────────────────────────────────────────────────────┐
│ HyperPod Cluster (SLURM Managed)                                          │
│  ├─ head   (ml.m5.xlarge) — 컨트롤러, 상시 운영                           │
│  ├─ gpu-g5-8x (ml.g5.8xlarge) — RL 학습 (0에서, debug 와 같은 타입)       │
│  │     -c gpuGroups=extended: g6e/g6/p4d/p5 그룹 추가                     │
│  │     (전부 노드 0에서 시작)                                             │
│  ├─ cpu-c5-4x / cpu-c5-9x / cpu-m5-4x — MuJoCo RL (CPU, 파티션 cpu, 0에서)│
│  └─ debug  (ml.g5.8xlarge)    — 디버깅/시각화 (0에서)                     │
├───────────────────────────────────────────────────────────────────────────┤
│ Storage                                                                   │
│  ├─ FSx for Lustre (1.2TB) ← /fsx 마운트                                  │
│  └─ S3 Data Bucket ↔ FSx 자동 동기화                                      │
├───────────────────────────────────────────────────────────────────────────┤
│ MLflow Tracking Server (SageMaker Managed)                                │
└───────────────────────────────────────────────────────────────────────────┘
```

## 사전 준비

- AWS CLI v2 + credentials 설정 완료
- Node.js 18+ / npm
- AWS CDK CLI (`npm install -g aws-cdk`)
- Session Manager Plugin ([설치 가이드](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html))
- 리전: `us-east-1` (배포 전 GPU 쿼터 확인 — 아래 참고)

---

## Step 1: CDK 프로젝트 설정

```bash
cd hyperpod-training/infra
npm install
```

CDK Bootstrap (최초 1회):
```bash
cdk bootstrap aws://ACCOUNT_ID/us-east-1
```

## Step 2: 인프라 배포

### 기본 배포

```bash
npx cdk deploy -c region=us-east-1 --require-approval never
```

### 배포 파라미터 커스터마이즈

`bin/app.ts`가 읽는 CDK context 파라미터입니다.

| 파라미터 | 기본값 | 설명 |
|---------|--------|------|
| `region` | `CDK_DEFAULT_REGION` | 배포 리전 |
| `createVpc` | true | VPC를 새로 생성 (false면 기존 VPC 사용) |
| `vpcCidr` | 10.0.0.0/16 | 생성할 VPC의 CIDR |
| `gpuMaxCount` | 4 | GPU 인스턴스 타입별 그룹의 최대 노드 수 |
| `gpuGroups` | core | GPU 그룹 프로필. `core` = gpu-g5-8x 하나(Workshop Studio SageMaker 허용 목록 호환), `extended` = g6e/g6/p4d/p5 그룹 추가 |
| `profile` | personal | 배포 프로필. `workshop-studio` = Workshop Studio 이벤트 계정(us-east-1/us-west-2에서만). head 노드는 두 프로필 모두 `ml.m5.xlarge` — 실측한 WS 계정 cluster usage 쿼터가 m5.xlarge 10, g5.* 0이었다 |
| `gpuCount` | 0 | 기본 학습 그룹(gpu-g5-8x, ml.g5.8xlarge)에서 기동할 노드 수 (배포 후에는 `scripts/scale-cluster.sh` 사용 권장) |
| `cpuMaxCount` | 2 | CPU 그룹(cpu-c5-4x / cpu-c5-9x / cpu-m5-4x) 각각의 최대 노드 수 |
| `cpuCount` | 0 | 기본 CPU 학습 그룹(cpu-c5-4x, ml.c5.4xlarge — MuJoCo RL)에서 기동할 노드 수 |
| `debugCount` | 0 | debug(DCV) 그룹에서 기동할 노드 수 (0 또는 1) |
| `gpuUseSpot` | false | GPU 그룹에 Spot 인스턴스 사용 |
| `fsxCapacityGiB` | 1200 | FSx 스토리지 용량 (GiB) |
| `enableMlflow` | false | (옵션) 관리형 MLflow 실험 추적 서버 생성 여부 |
| `amiUpdateSchedule` | (꺼짐) | AMI 보안 패치 스케줄. `default`(`cron(00 18 ? * 1#2 *)`) 또는 cron 식으로 켠다. 켜면 이후 `cdk deploy`가 HyperPod의 ScheduledUpdateConfig 수정 거부로 실패하므로 기본은 꺼짐 |

예시 — 소규모 테스트:
```bash
npx cdk deploy \
  -c region=us-east-1 \
  -c gpuMaxCount=1 \
  -c fsxCapacityGiB=1200 \
  --require-approval never
```

> **GPU 쿼터 확인 필수.** GPU 인스턴스 그룹은 `lib/config/cluster-config.ts`의
> 프로필(`core`: g5-8x / `extended`: + g6e/g6/p4d/p5)대로 타입별로 하나씩 생성되며, 초기 노드 수는
> 모두 0입니다. 쿼터가 0인 타입은 job이 영구히 `PENDING`에 머무르므로 배포 전에 확인하세요.
>
> ```bash
> aws service-quotas list-service-quotas --service-code sagemaker --region us-east-1 \
>   --query "Quotas[?contains(QuotaName,'cluster usage') && Value>\`0\`].[QuotaName,Value]" --output text
> ```

### 배포 확인 (약 20분 소요)

```bash
# 스택 상태 확인
aws cloudformation describe-stacks \
  --stack-name HyperPod-<ACCOUNT_ID> \
  --region us-east-1 \
  --query "Stacks[0].StackStatus"

# 출력값 확인
aws cloudformation describe-stacks \
  --stack-name HyperPod-<ACCOUNT_ID> \
  --region us-east-1 \
  --query "Stacks[0].Outputs"
```

## GPU 노드 스케일 업/다운 (scale-cluster.sh)

GPU 인스턴스 그룹은 배포 직후 노드 수 0으로 시작합니다 (비용 0). 학습 직전에
노드를 올리고, 끝나면 다시 0으로 내립니다. CDK 재배포 없이
`aws sagemaker update-cluster`를 감싼 스크립트를 사용하세요:

```bash
# 학습용 GPU 노드 1대 기동 (InService까지 대기, 10~20분)
./scripts/scale-cluster.sh gpu-g5-8x 1 --wait

# 학습 종료 후 0으로 축소
./scripts/scale-cluster.sh gpu-g5-8x 0

# DCV 디버그 노드 (시각화 검증)
./scripts/scale-cluster.sh debug 1 --wait

# MuJoCo RL 용 CPU 노드 (Slurm 경로, Slurm 경로 S3)
./scripts/scale-cluster.sh cpu-c5-4x 1 --wait
```

> 스크립트는 CloudFormation 밖에서 노드 수를 바꾸므로 CDK 스택과 드리프트가 생깁니다.
> 이후 `cdk deploy`를 다시 실행하면 노드 수가 context 값(기본 0)으로 되돌아가고,
> `cdk destroy`에는 영향이 없습니다. IaC로 일관되게 관리하고 싶다면
> `-c gpuCount=1` 재배포 방식도 유효합니다(이때 기존 배포에 사용한 다른 context
> 값들을 반드시 함께 지정).

## MuJoCo (CPU) RL — GPU 노드 없이 학습·검증 (Slurm 경로 S3)

`ml.g5.*` cluster 쿼터가 0인 계정(Workshop Studio 이벤트 계정 등)을 위한 경로. CPU 그룹
(`cpu-c5-4x`, 16 vCPU)에서 SO-101 Reach 태스크를 MuJoCo + Stable-Baselines3(PPO)로 학습하고,
오프스크린 렌더링으로 mp4/gif를 만들어 검증한다. 관측·행동·보상은 Isaac Lab Reach와 동일하게 설계.

```bash
# [code-server] CPU 노드 기동 (5~10분)
./scripts/scale-cluster.sh cpu-c5-4x 1 --wait

# [head node] 최초 1회: /fsx/envs/mujoco venv + mujoco_menagerie(robotstudio_so101) + 태스크 패키지
bash /fsx/scratch/aws-physical-ai-recipes/hyperpod-training/scripts/setup_mujoco_env.sh

# [head node] 학습 (cpu 파티션, 1M 스텝 ≈ 5분) → /fsx/checkpoints/rl/reach-mujoco/SO101_Reach/
sbatch slurm-templates/rl/train_mujoco.sbatch          # TASK / NUM_ENVS / TOTAL_STEPS / CHECKPOINT
slurm-templates/rl/run_mujoco.sh --steps 3000000        # 래퍼

# [head node] 평가 + 영상 (model_best.zip → videos/model_best.{mp4,gif}, S3 로 동기화)
sbatch slurm-templates/rl/play_mujoco.sbatch           # CHECKPOINT / EPISODES / MUJOCO_GL
CHECKPOINT=untrained EPISODES=2 sbatch slurm-templates/rl/play_mujoco.sbatch   # 학습 전 비교 영상 (videos/untrained.gif)

# [head node] 영상 대신 실시간으로: CPU 노드의 DCV 데스크톱(xfce + Mesa, GPU 없음)에 접속한 뒤
# 그 안에서 python examples/rl/play_mujoco.py --viewer --checkpoint <model.zip>
sbatch slurm-templates/debug/dcv_session_cpu.sbatch  # SSM 포트포워딩 + 뷰어 명령을 로그로 출력

# [code-server] 끝나면 0으로
./scripts/scale-cluster.sh cpu-c5-4x 0
```

| 파일 | 역할 |
|---|---|
| `mujoco-workshop/` | `Workshop-SO101-Reach-MuJoCo-v0` Gymnasium 태스크 패키지 (`so101_reach.py`) |
| `scripts/setup_mujoco_env.sh` | FSx venv 생성, menagerie 고정 커밋 sparse checkout, 패키지 설치, smoke test (head node에서 실행) |
| `examples/rl/train_mujoco.py` | SB3 PPO + SubprocVecEnv(vCPU당 1 프로세스) + VecNormalize, model_best.zip 선택, TensorBoard `reward_terms/` |
| `examples/rl/play_mujoco.py` | 결정적 평가(성공률·최종 거리) + `MUJOCO_GL=egl` 오프스크린 mp4/gif, `--untrained`로 학습 전 비교 영상, `--viewer`로 DCV 데스크톱에 실시간 MuJoCo 창 |
| `slurm-templates/rl/train_mujoco.sbatch`, `play_mujoco.sbatch`, `run_mujoco.sh` | `--partition=cpu` Slurm 템플릿 |
| `slurm-templates/debug/dcv_session_cpu.sbatch` | CPU 노드 DCV 세션(setup_dcv.sh가 CPU 노드에도 xfce + DCV 설치); SSM target과 `--viewer` 명령을 출력 |

## EKS 오케스트레이션 경로 — observability · task governance (워크숍 모듈 8~11, RL 트랙 메인 경로)

같은 CDK 앱에 `-c orchestrator=eks`를 주면 Slurm 스택과 별개로 **EKS 오케스트레이션 HyperPod** 스택
`HyperPodEks-<ACCOUNT_ID>`(클러스터 `hyperpod-eks-<ACCOUNT_ID>`)를 배포한다. Slurm 경로에서 소개만 하고
넘어간 두 운영 축을 실제로 쓴다.

- **Observability** — EKS 애드온 `amazon-sagemaker-hyperpod-observability` + Amazon Managed Service for
  Prometheus(AMP) + Grafana. CDK가 AMP 워크스페이스·애드온·Grafana(기본: 클러스터 안 Helm 설치, AMP를 SigV4로
  읽음)를 만들어 GPU·노드·Kueue 대시보드가 바로 보인다. IAM Identity Center 조직 인스턴스가 있는 계정은
  `-c grafanaMode=amg`로 Amazon Managed Grafana를 대신 쓸 수 있다.
- **Task governance** — EKS 애드온 `amazon-sagemaker-hyperpod-taskgovernance`(Kueue). cluster policy(우선순위
  클래스)와 팀별 compute quota를 CLI로 만들면 팀 네임스페이스·LocalQueue가 자동 생성되고, Job은 큐를 거쳐
  할당량·우선순위에 따라 실행·대기·선점된다.

```
┌────────────────────────────────────────────────────────────────────┐
│ EKS 컨트롤 플레인 (hyperpod-eks-<ACCOUNT_ID>, K8s 1.34)            │
│   HyperPodHelmChart: HMA, deep health check, nvidia/EFA plugin,    │
│   Kubeflow training/MPI operator                                   │
│   애드온: pod-identity-agent, aws-fsx-csi-driver,                  │
│           hyperpod-observability, hyperpod-taskgovernance(Kueue)   │
├────────────────────────────────────────────────────────────────────┤
│ HyperPod 인스턴스 그룹 (NodeProvisioningMode: Continuous)          │
│  ├─ cpu-c5-4x  (ml.c5.4xlarge) ×1 상시 — 애드온 파드 + MuJoCo CPU  │
│  └─ gpu-g5-8x  (ml.g5.8xlarge) ×0 — Isaac Lab RL (scale-cluster.sh)│
├────────────────────────────────────────────────────────────────────┤
│ FSx for Lustre (/fsx, CSI 정적 PV) ↔ S3 hyperpod-eks-data-…        │
│ AMP 워크스페이스 → Grafana (in-cluster, port-forward | AMG 옵션)   │
└────────────────────────────────────────────────────────────────────┘
```

두 프로필 모두 배포할 수 있다. `profile=workshop-studio`(이벤트 계정)는 GPU cluster 쿼터가 0이므로 GPU 그룹은 0대로 두고
상시 시스템 그룹 cpu-c5-4x(ml.c5.4xlarge) 1대에서 MuJoCo CPU 경로(모듈 9)로 학습·검증하고, 모듈 11에서 2대로 올려 거버넌스·관측 실습을 진행한다. 이벤트에서는 프로비저너
템플릿(`physical-ai-on-aws/static/e2e-workshop-provisioner.yaml`)의 `DeployHyperPodEks=true`가 이 스택을 미리 배포한다.

### 배포

```bash
cd hyperpod-training/infra
npm install
npx cdk deploy -c orchestrator=eks -c region=${REGION} --require-approval never   # ~35분
```

| 파라미터 | 기본값 | 설명 |
|---------|--------|------|
| `orchestrator` | `slurm` | `eks`로 지정 |
| `eksVersion` | `1.34` | Kubernetes 버전. task governance 애드온의 Kueue 0.19가 `resource.k8s.io/v1`(1.34+)을 요구한다 |
| `eksAdminArns` | (배포자) | 클러스터 admin 액세스 엔트리를 추가로 줄 IAM principal ARN, 쉼표 구분. 배포자는 `aws sts get-caller-identity`로 자동 포함 |
| `systemNodeCount` | 1 | 상시 시스템 노드(cpu-c5-4x) 수. 애드온은 노드가 1대 이상(4xlarge 이상) 있어야 설치된다 |
| `enableObservability` | true | AMP + Grafana + observability 애드온 |
| `grafanaMode` | `self-hosted` | `self-hosted` = 클러스터 안 Grafana(Helm, `kubectl port-forward`, 서브패스 `/absproxy/3000/` = code-server absproxy 경로), `amg` = Amazon Managed Grafana(IAM Identity Center **조직** 인스턴스 필요 — 계정 인스턴스는 "SSO is not enabled" 로 실패), `none` |
| `enableTaskGovernance` | true | task governance 애드온 |
| `deepHealthChecks` | false | GPU 그룹 `OnStartDeepHealthChecks`(InstanceStress, InstanceConnectivity). 켜면 노드 기동이 길어진다 |
| `gpuGroups`, `gpuMaxCount`, `gpuCount`, `gpuUseSpot`, `fsxCapacityGiB`, `vpcCidr` | Slurm과 동일 | |

주요 Output: `KubeconfigCommand`, `ClusterName`, `ClusterArn`, `AmpWorkspaceId`, `GrafanaAccess`(self-hosted) 또는
`GrafanaUrl`/`GrafanaWorkspaceId`(amg), `S3BucketName`, `FsxFileSystemId`/`FsxDnsName`/`FsxMountName`.

### 배포 후

```bash
cd hyperpod-training
./scripts/eks/kubeconfig.sh                       # kubectl 컨텍스트 hyperpod-eks + 노드/애드온 확인
kubectl port-forward -n grafana svc/grafana 3000:80 &   # Grafana → https://<CodeServerUrl>/absproxy/3000/ 또는 http://localhost:3000/absproxy/3000/ (admin / Secret grafana 의 admin-password)
kubectl get secret -n grafana grafana -o jsonpath='{.data.admin-password}' | base64 -d; echo
# grafanaMode=amg 인 경우: ./scripts/eks/grafana-user.sh <IdC-username>  → Output GrafanaUrl 로 로그인
```

### Job 제출 (k8s-templates)

모듈 9 (학습·검증): 일반 네임스페이스 `rl`, Kueue 없이 상시 시스템 노드에서 바로 스케줄

```bash
cd hyperpod-training/k8s-templates
./render.sh fsx-pvc.yaml --apply                                   # rl 네임스페이스 생성 + /fsx PV+PVC
./render.sh setup/workshop-setup-job.yaml --apply                  # 최초 1회: 레시피·태스크 패키지를 /fsx 에
./render.sh rl/mujoco-setup-job.yaml --apply                       # 최초 1회: /fsx/envs/mujoco venv (~4분)
TOTAL_STEPS=1000000 ./render.sh rl/mujoco-train-job.yaml --apply   # MuJoCo SO-101 Reach (CPU 12 vCPU, ~5분)
kubectl get jobs,pods -n rl
kubectl logs -n rl -l app=mujoco-rl -f
./render.sh rl/mujoco-render-job.yaml --apply                      # 정책 검증: 성공률 + mp4/gif (OSMesa, ~5분)

# GPU 쿼터가 있는 계정(모듈 10): Isaac Lab
../scripts/scale-cluster.sh gpu-g5-8x 1 --wait --cluster hyperpod-eks-<ACCOUNT_ID>
MAX_ITERATIONS=50 ./render.sh rl/isaaclab-train-job.yaml --apply   # Isaac Lab SO-101 Reach (GPU)
```

모듈 11 (task governance · observability): 팀 네임스페이스 `hyperpod-ns-team-a/b`, Kueue 큐 경유

```bash
../scripts/eks/create-governance.sh                                # cluster policy + team-a / team-b compute quota
../scripts/scale-cluster.sh cpu-c5-4x 2 --wait --cluster hyperpod-eks-<ACCOUNT_ID>   # 두 팀 Job 을 겹치기 위한 CPU 노드 1대 추가 (~3분)
export NAMESPACE=hyperpod-ns-team-a
./render.sh fsx-pvc.yaml --apply                                   # team-a 네임스페이스에 /fsx PV+PVC
NAMESPACE=hyperpod-ns-team-b ./render.sh fsx-pvc.yaml --apply     # team-b
LOG_DIR=/fsx/scratch/governance-demo/team-a PRIORITY=background-priority ./render.sh rl/mujoco-train-job.yaml --apply   # Kueue 라벨이 채워진다
kubectl get workloads -A
```

| 파일 | 역할 |
|---|---|
| `k8s-templates/render.sh` | `${NAMESPACE}` `${QUEUE}` `${PRIORITY}` `${TASK}` 등 치환 + `--apply`. 기본 네임스페이스 `rl`(없으면 생성), `hyperpod-ns-*` 를 주면 Kueue 라벨을 채우고 그 외에는 라벨 줄을 제거 |
| `k8s-templates/fsx-pvc.yaml` | 네임스페이스용 FSx PV+PVC (정적 PV는 PVC 하나에만 바인딩되므로 네임스페이스마다 한 쌍) |
| `k8s-templates/setup/workshop-setup-job.yaml` | 레시피 clone + Isaac Lab 태스크 패키지 배치 (Slurm Slurm 경로 S2 §S2.3 대응) |
| `k8s-templates/rl/isaaclab-train-job.yaml` | `nvcr.io/nvidia/isaac-lab:2.3.0`, `nvidia.com/gpu: 1`, Kueue 라벨 (finetune_isaaclab.sbatch 대응) |
| `k8s-templates/rl/mujoco-setup-job.yaml`, `mujoco-train-job.yaml`, `mujoco-render-job.yaml` | `/fsx/envs/mujoco` venv + SB3 PPO on ml.c5.4xlarge (train_mujoco.sbatch 대응), 정책 검증 영상 (play_mujoco.sbatch 대응) |
| `k8s-templates/governance/*.json` | cluster policy, team-a/team-b compute quota 입력 |
| `scripts/eks/kubeconfig.sh` · `grafana-user.sh` · `create-governance.sh` · `delete-governance.sh` | 접속 · Grafana(AMG) 사용자 · 정책 생성/삭제 |
| `eks/grafana-dashboards/hyperpod-task-governance.json` | Kueue 대기/실행/선점, ClusterQueue 할당·대여, DCGM GPU 사용률 대시보드 (self-hosted Grafana 에 프로비저닝) |
| `lifecycle-scripts/on_create_eks.sh` | EKS 노드 lifecycle. CPU 노드는 진단 로그만(kubelet/plugin은 HyperPod·Helm이 처리). GPU 노드는 `setup_nvidia_driver.sh`(Isaac Sim 렌더링용 580 드라이버) + `setup_dcv_al2023.sh`(AL2023 GNOME + DCV, 세션 `workspace`, ec2-user/hyperpod)를 추가 실행 (모듈 10 §10.7 방법 B) |
| `lifecycle-scripts/setup_dcv_al2023.sh` | Amazon Linux 2023(EKS AMI)용 DCV 설치. Slurm AMI(Ubuntu)의 `setup_dcv.sh`에 해당하며 Docker 는 설치하지 않는다 |
| `k8s-templates/rl/isaaclab-play-job.yaml` | GPU 노드 DCV 세션에 Isaac Sim 창을 띄우는 재생 Job (hostPath `/tmp/.X11-unix`, `X_DISPLAY` 자동 선택) |
| `scripts/eks/dcv-target.sh` | GPU 노드의 SSM target 과 DCV 포트포워딩 명령 출력 |
| `eks/helm/HyperPodHelmChart` | vendored HyperPod Helm 의존성 (`VENDOR.md`) |

### 정리

```bash
./scripts/eks/delete-governance.sh                                   # compute quota → cluster policy (남아 있으면 클러스터 삭제가 막힌다)
./scripts/scale-cluster.sh gpu-g5-8x 0 --cluster hyperpod-eks-<ACCOUNT_ID>
aws s3 rm s3://hyperpod-eks-data-<ACCOUNT_ID>-<REGION> --recursive
cd infra && npx cdk destroy -c orchestrator=eks -c region=${REGION} --force   # ~25분
```

## Step 3: 클러스터 상태 확인

```bash
CLUSTER_NAME="hyperpod-<ACCOUNT_ID>"

# 클러스터 상태
aws sagemaker describe-cluster \
  --cluster-name ${CLUSTER_NAME} \
  --region us-east-1 \
  --query "{Status:ClusterStatus,Groups:InstanceGroups[*].{Name:InstanceGroupName,Count:CurrentCount,Status:Status}}"

# 노드 목록
aws sagemaker list-cluster-nodes \
  --cluster-name ${CLUSTER_NAME} \
  --region us-east-1
```

예상 결과:
```json
{
  "Status": "InService",
  "Groups": [
    { "Name": "head",        "Count": 1, "Status": "InService" },
    { "Name": "gpu-g5-8x",  "Count": 0, "Status": "InService" },
    { "Name": "debug",       "Count": 0, "Status": "InService" }
  ]
}
```

## AMI 보안 패치 (Scheduled Update)

HyperPod AMI에는 커널·NVIDIA 드라이버·OpenSSL 등이 포함되고, AWS가 주기적으로 보안 패치 AMI를 릴리스합니다. 패치하지 않으면 노드는 생성 당시 AMI에 그대로 머무릅니다.

**예약 스케줄은 기본으로 꺼져 있습니다.** `-c amiUpdateSchedule=default`로 배포하면 `DEFAULT_AMI_UPDATE_SCHEDULE`(`lib/config/cluster-config.ts`, 매월 둘째 일요일 18:00 UTC)이 모든 인스턴스 그룹의 `ScheduledUpdateConfig`에 적용됩니다. 단, HyperPod는 한 번 설정된 `ScheduledUpdateConfig`의 수정을 거부하므로 스케줄이 켜진 스택은 이후 `cdk deploy`(노드 수·그룹 변경)가 실패합니다. 워크숍처럼 클러스터를 계속 갱신하는 경우에는 꺼 두고 아래처럼 수동 패치를 쓰세요.

```bash
# 스케줄 확인
aws sagemaker describe-cluster --cluster-name ${CLUSTER_NAME} --region us-east-1 \
  --query "InstanceGroups[].{Name:InstanceGroupName,Schedule:ScheduledUpdateConfig.ScheduleExpression}"

# 마지막 패치 시각 확인 (LaunchTime과 같으면 한 번도 패치되지 않은 것)
aws sagemaker list-cluster-nodes --cluster-name ${CLUSTER_NAME} --region us-east-1 \
  --query "ClusterNodeSummaries[].{Group:InstanceGroupName,Launch:LaunchTime,LastPatch:LastSoftwareUpdateTime}"

# 예약 시각을 기다리지 않고 즉시 패치 (아래 사전 조건을 먼저 확인)
aws sagemaker update-cluster-software --cluster-name ${CLUSTER_NAME} --region us-east-1
```

스케줄을 켜려면 `-c amiUpdateSchedule=default`, 주기를 직접 주려면 `-c amiUpdateSchedule='cron(00 18 1 * ? *)'`를 씁니다.

### 패치 전 반드시 확인할 것

1. **라이프사이클 버킷이 살아 있어야 합니다.** 패치는 루트 볼륨을 새 AMI로 교체한 뒤 `LifeCycleConfig.SourceS3Uri`의 `on_create.sh`를 다시 실행합니다. 버킷이 없으면 패치가 실패하고 클러스터가 `Failed`로 떨어집니다.
   ```bash
   aws s3 ls s3://hyperpod-lifecycle-<account>-<region>/lifecycle-scripts/
   ```
2. **루트 볼륨은 초기화됩니다.** `/fsx`(FSx Lustre)는 유지되지만 `/home/ubuntu`, Slurm accounting DB(mariadb) 등 루트 볼륨 데이터는 사라집니다. 필요하면 AWS 제공 [`patching-backup.sh`](https://github.com/aws-samples/awsome-distributed-training/blob/main/1.architectures/5.sagemaker-hyperpod/patching-backup.sh)로 S3에 백업합니다.
   ```bash
   sudo bash patching-backup.sh --create s3://<backup-bucket-path>   # 패치 전
   sudo bash patching-backup.sh --restore s3://<backup-bucket-path>  # 패치 후
   ```
3. **실행 중인 작업이 없어야 합니다.** Slurm 클러스터는 인스턴스 그룹이 한꺼번에 교체되므로 진행 중인 job은 중단됩니다(`squeue`로 확인).

### Slurm 클러스터의 제약

| 기능 | Slurm | 비고 |
|---|---|---|
| `ScheduledUpdateConfig` (cron 예약) | ✅ | 옵션(`-c amiUpdateSchedule`); 기본 꺼짐 |
| `AutoPatchConfig` (유휴 노드 자동 패치, 워크로드 무중단) | ❌ | **EKS 전용** |
| `DeploymentConfig` (배치 롤링 교체 + CloudWatch 자동 롤백) | ❌ | **EKS 전용** |
| 콘솔에서 Update AMI | ❌ | **EKS 전용**, API/CLI만 가능 |

즉 Slurm에서는 워크로드를 피해가는 패치가 불가능하므로, 예약 시각을 학습이 없는 시간대로 잡는 것이 중요합니다.
참고: [AMI 업데이트 문서](https://docs.aws.amazon.com/sagemaker/latest/dg/sagemaker-hyperpod-release-ami-update.html) · [자동 패치 문서](https://docs.aws.amazon.com/sagemaker/latest/dg/sagemaker-hyperpod-ami-auto-patching.html)

## Step 4: Head Node 접속 (SSH via Jump Host)

CDK 배포 시 Jump Host가 Public Subnet에 생성됩니다. 이를 경유하여 Head Node에 SSH 접속합니다.

### 4.1 SSH 키 다운로드

CDK 출력값의 `JumpKeyCommand`를 실행하여 Jump Host의 SSH 키를 다운로드합니다.

```bash
# Jump Host SSH 키 다운로드
aws ssm get-parameter \
  --name /ec2/keypair/<KEY_PAIR_ID> \
  --with-decryption \
  --query Parameter.Value \
  --output text \
  --region us-east-1 > ~/.ssh/hyperpod-jump.pem

chmod 600 ~/.ssh/hyperpod-jump.pem
```

> `<KEY_PAIR_ID>`는 CDK 출력의 `JumpKeyCommand`에서 확인할 수 있습니다.

### 4.2 Jump Host 접속

```bash
JUMP_IP="<CDK 출력의 JumpHostIp>"

ssh -i ~/.ssh/hyperpod-jump.pem ec2-user@${JUMP_IP}
```

### 4.3 Head Node 접속

Jump Host에는 Head Node 접속용 키(`~/.ssh/cluster_access_key`)가 자동으로 배포되어 있습니다.

```bash
# Jump Host에서 실행
HEAD_IP="<head node private IP>"  # describe-cluster-node으로 확인

ssh -i ~/.ssh/cluster_access_key ubuntu@${HEAD_IP}
```

또는 로컬에서 ProxyJump로 한 번에 접속:
```bash
ssh -i ~/.ssh/hyperpod-jump.pem -o ProxyCommand="ssh -i ~/.ssh/hyperpod-jump.pem -W %h:%p ec2-user@${JUMP_IP}" \
  -i <(aws s3 cp s3://hyperpod-lifecycle-<ACCOUNT_ID>-us-east-1/ssh/cluster_access_key -) \
  ubuntu@${HEAD_IP}
```

### 4.4 SSH Config 설정 (권장)

`~/.ssh/config`에 아래를 추가하면 `ssh hyperpod`로 바로 접속 가능합니다:

```
Host hyperpod-jump
    HostName <JUMP_IP>
    User ec2-user
    IdentityFile ~/.ssh/hyperpod-jump.pem

Host hyperpod
    HostName <HEAD_NODE_PRIVATE_IP>
    User ubuntu
    IdentityFile ~/.ssh/cluster_access_key
    ProxyJump hyperpod-jump
```

> `cluster_access_key`는 Jump Host의 `~/.ssh/cluster_access_key`를 로컬로 복사하거나, S3에서 다운로드합니다:
> ```bash
> aws s3 cp s3://hyperpod-lifecycle-<ACCOUNT_ID>-us-east-1/ssh/cluster_access_key ~/.ssh/cluster_access_key
> chmod 600 ~/.ssh/cluster_access_key
> ```

### 4.5 접속 후 확인

```bash
sinfo                  # SLURM 파티션 상태
df -h /fsx             # FSx 마운트 확인
ls /fsx/               # datasets, checkpoints, scratch 디렉토리
```

## Step 5: 데이터셋 업로드 (S3 → FSx 자동 동기화)

S3에 데이터를 업로드하면 FSx `/fsx/datasets/`에 자동으로 동기화됩니다.

```bash
# 로컬에서 S3로 데이터 업로드
BUCKET="hyperpod-data-<ACCOUNT_ID>-us-east-1"

aws s3 cp ./my-dataset/ s3://${BUCKET}/datasets/groot/my-robot/ --recursive

# 수분 후 head node에서 확인
ls /fsx/datasets/groot/my-robot/
```

### LeRobot v2 형식 데이터셋 구조

```
/fsx/datasets/groot/aloha/
├── meta/
│   ├── info.json
│   ├── episodes.jsonl
│   └── tasks.jsonl
├── data/
│   ├── chunk-000/
│   │   └── episode_000000.parquet
│   └── ...
└── videos/
    ├── chunk-000/
    │   └── observation.images.top/
    │       └── episode_000000.mp4
    └── ...
```

## Step 6: VLA 학습 실행 (GR00T Fine-tuning)

### SLURM 작업 제출

```bash
# head node에서 실행
cd /fsx/scratch

# 학습 스크립트 복사 (S3에서 자동 동기화되었거나 직접 복사)
cp /path/to/examples/vla/train_groot.py .

# SLURM 템플릿으로 제출
/path/to/slurm-templates/vla/run_vla.sh \
  --model groot \
  --dataset /fsx/datasets/groot/aloha \
  --epochs 50 \
  --nodes 1
```

### 직접 sbatch 제출

```bash
sbatch --partition=dev --gres=gpu:4 --nodes=1 <<'EOF'
#!/bin/bash
#SBATCH --job-name=groot-finetune
#SBATCH --output=/fsx/scratch/logs/groot-%j.out

srun --container-image=nvcr.io/nvidia/gr00t:1.6.0 \
     --container-mounts=/fsx:/fsx \
     torchrun --nproc_per_node=4 \
       /fsx/scratch/train_groot.py \
       --dataset-path /fsx/datasets/groot/aloha \
       --modality-config aloha \
       --output-dir /fsx/checkpoints/vla/groot-aloha \
       --max-steps 5000
EOF
```

### 작업 모니터링

```bash
squeue                              # 작업 큐 확인
squeue -j <JOB_ID>                  # 특정 작업 상태
tail -f /fsx/scratch/logs/groot-<JOB_ID>.out  # 실시간 로그
scancel <JOB_ID>                    # 작업 취소
```

## Step 7: RL 학습 실행 (IsaacLab + Ray)

Actor-Learner 패턴으로 시뮬레이션과 학습을 동시 실행합니다.

```bash
# head node에서 실행
/path/to/slurm-templates/rl/run_rl.sh \
  --env Isaac-Cartpole-v0 \
  --num-actors 8

# 출력 예시:
# === RL Training: Isaac-Cartpole-v0 ===
#   Actors: 8
#   Learner job: 123
#   Actor jobs: 124 (array 0-7)
```

## Step 8: MLflow로 실험 추적

### MLflow 설정

```bash
# head node에서 MLflow 클라이언트 설치
pip install mlflow sagemaker-mlflow boto3

# 트래킹 URI 설정 (CDK 출력값 사용)
export MLFLOW_TRACKING_URI="https://us-east-1.experiments.sagemaker.aws/mlflow/hyperpod-<ACCOUNT_ID>-mlflow"
```

### MLflow UI 접근

SageMaker Managed MLflow UI는 CDK 배포 시 출력되는 `MLflowTrackingUri`로 접근합니다:
```
https://us-east-1.experiments.sagemaker.aws/mlflow/hyperpod-<ACCOUNT_ID>-mlflow
```

### 학습 코드에서 MLflow 사용

```python
import mlflow

mlflow.set_tracking_uri(os.environ["MLFLOW_TRACKING_URI"])
mlflow.set_experiment("groot-finetune")

with mlflow.start_run():
    mlflow.log_params({"lr": 2e-5, "batch_size": 32})
    # ... 학습 루프 ...
    mlflow.log_metrics({"loss": 0.01, "accuracy": 0.95}, step=1000)
```

## Step 9: 체크포인트 확인 (FSx → S3 자동 익스포트)

학습 결과가 `/fsx/checkpoints/`에 저장되면 S3로 자동 익스포트됩니다.

```bash
# FSx에서 확인
ls /fsx/checkpoints/vla/groot-aloha/

# S3에서 확인 (수분 후 동기화)
aws s3 ls s3://${BUCKET}/checkpoints/vla/groot-aloha/
```

## Step 10: 리소스 정리

CloudFormation은 빈 버킷만 삭제한다. destroy 시점에 두 버킷은 비어 있지 않으므로(lifecycle 버킷: 스택이 올린 스크립트 + 클러스터가 기록한 `config/head_ip.txt`, 데이터 버킷: FSx에서 동기화된 체크포인트/데이터셋) **먼저 비우고 destroy 한다.**

```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
REGION=us-east-1

# 1) S3 버킷 두 개 비우기 (필수)
aws s3 rm s3://hyperpod-data-${ACCOUNT_ID}-${REGION} --recursive --region ${REGION}
aws s3 rm s3://hyperpod-lifecycle-${ACCOUNT_ID}-${REGION} --recursive --region ${REGION}

# 2) 스택 삭제 (클러스터 + FSx + Jump Host + VPC, 약 20분)
cd hyperpod-training/infra
npx cdk destroy -c region=${REGION} --force
```

스택이 `DELETE_FAILED`(The bucket you tried to delete is not empty)로 끝나면 — 1)을 건너뛰었거나, 데이터 버킷의 버저닝 때문에 이전 버전·삭제 마커가 남은 경우 — 실패한 버킷의 모든 버전을 지우고 삭제를 재실행한다. 이 시점에 클러스터·FSx·NAT GW·Jump Host는 이미 삭제돼 있다.

```bash
aws cloudformation describe-stack-events --stack-name HyperPod-${ACCOUNT_ID} --region ${REGION} \
  --query "StackEvents[?ResourceStatus=='DELETE_FAILED'].[LogicalResourceId,PhysicalResourceId]" --output table

BUCKET=hyperpod-data-${ACCOUNT_ID}-${REGION}   # 또는 hyperpod-lifecycle-${ACCOUNT_ID}-${REGION}
aws s3api list-object-versions --bucket $BUCKET --region ${REGION} \
  --query '{Objects: [Versions[].{Key:Key,VersionId:VersionId}, DeleteMarkers[].{Key:Key,VersionId:VersionId}][] }' \
  --output json > /tmp/versions.json
aws s3api delete-objects --bucket $BUCKET --region ${REGION} --delete file:///tmp/versions.json

aws cloudformation delete-stack --stack-name HyperPod-${ACCOUNT_ID} --region ${REGION}
aws cloudformation wait stack-delete-complete --stack-name HyperPod-${ACCOUNT_ID} --region ${REGION}
```

워크숍 참가자용 절차는 콘텐츠 모듈 12 §12.7B와 동일하다.

---

## 트러블슈팅

### 배포 실패: "Unable to retrieve subnets"
- Execution Role에 EC2 VPC 권한 필요 → CDK에 이미 포함됨

### 배포 실패: "InstanceGroups must have a SlurmConfig with Controller node type"
- head 그룹에 `SlurmConfig: { NodeType: Controller }` 필요 → CDK에 이미 포함됨

### SSM 접속 안 됨
- AWS Console에서 접속하세요 (SageMaker > HyperPod > Clusters > Connect)
- CLI 접속에는 session-manager-plugin 설치 필요

### FSx 마운트 안 됨
- Lifecycle script의 FSX_DNS_NAME/FSX_MOUNT_NAME이 설정되어야 함
- 클러스터 생성 후 FSx 정보를 lifecycle script에 설정 필요

### MLflow "already exists" 에러
- 이전 배포에서 MLflow 서버가 남아있음
- `aws sagemaker delete-mlflow-tracking-server --tracking-server-name <name>` 후 재배포

### 패치 실패: "The lifecycle configuration bucket ... was not found or does not exist"
- 라이프사이클 스크립트 버킷이 삭제된 상태에서 `update-cluster-software`를 호출한 경우
- 클러스터가 `SystemUpdating` → `RollingBack` → `Failed`로 떨어짐 (노드는 교체 전에 중단되므로 데이터는 보존됨)
- 복구: 같은 이름으로 버킷을 다시 만들고 스크립트를 올린 뒤 패치를 재시도
  ```bash
  B=hyperpod-lifecycle-<account>-us-east-1
  aws s3api create-bucket --bucket $B --region us-east-1 \
    --create-bucket-configuration LocationConstraint=us-east-1
  aws s3 cp lifecycle-scripts/ s3://$B/lifecycle-scripts/ --recursive --exclude "*" --include "*.sh"
  printf '%s' "$B" | aws s3 cp - s3://$B/lifecycle-scripts/bucket.conf
  aws sagemaker update-cluster-software --cluster-name <cluster> --region us-east-1
  ```
- 예방: 버킷에 삭제 방지를 걸거나, 패치 전 사전 점검 항목으로 버킷 존재를 확인

### S3 버킷 삭제 실패
- 버킷이 비어있지 않으면 삭제 불가
- `aws s3 rm s3://<bucket-name> --recursive` 후 스택 삭제 재시도

---

## 비용 참고

| 컴포넌트 | 시간당 비용 | 비고 |
|---------|------------|------|
| Head Node (ml.m5.xlarge) | ~$0.20 | 상시 운영 |
| Train (gpu-g5-8x, ml.g5.8xlarge) | ~$3.00 | 학습 시에만 |
| Debug (ml.g5.8xlarge) | ~$3.00 | 시각 검증 시에만 |
| FSx (1.2TB) | ~$0.55 | 상시 |
| MLflow | ~$0.10 | 상시 |
| **실습 중 (head only)** | **~$0.85/hr** | |
| **학습 실행 시** | **~$8-10/hr** | |

실습 후 반드시 `cdk destroy`로 정리하세요.

---

## 다음 단계

- [아키텍처 상세 문서](./docs/architecture.md)
- [리서처 가이드](./docs/researcher_guide.md)
- [VLA 학습 예제](./examples/vla/)
- [RL 학습 예제](./examples/rl/)
- [SLURM 템플릿](./slurm-templates/)
