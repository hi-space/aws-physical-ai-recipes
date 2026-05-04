# OSMO on AWS EKS Workshop Guide

NVIDIA OSMO를 AWS EKS에 배포하고, GR00T Fine-tuning 워크플로를 실행하는 실습 가이드입니다.

## OSMO란?

[NVIDIA OSMO](https://github.com/NVIDIA/OSMO)는 Physical AI를 위한 오픈소스 워크플로 오케스트레이터입니다. 로봇 학습(GR00T Fine-tuning)이나 시뮬레이션 데이터 생성(Isaac Sim) 같은 GPU 집약적 작업을 Kubernetes 위에서 간단한 YAML 파일 하나로 실행할 수 있게 해줍니다.

이 워크샵에서는:
1. AWS에 OSMO 실행 환경을 구축하고
2. NVIDIA GR00T 로봇 모델을 fine-tuning하는 워크플로를 실제로 실행합니다

---

## 실습 개요

| Step | 내용 | 소요 시간 |
|------|------|-----------|
| 1 | 인프라 배포 (CDK) | ~20분 |
| 2 | Kubernetes 기본 설정 (NVIDIA Plugin, RuntimeClass) | ~5분 |
| 3 | OSMO 설치 (Helm) | ~10분 |
| 4 | OSMO 구성 (Credential, Config, Queue) | ~10분 |
| 5 | GPU 워크플로 검증 | ~5분 |
| 6 | GR00T Fine-tuning 실행 | ~20분 |
| 7 | 정리 (Cleanup) | ~10분 |

---

## 사전 요구사항

다음 도구들이 설치되어 있어야 합니다:

```bash
# AWS CLI — AWS 리소스를 관리하는 커맨드라인 도구
aws --version
aws sts get-caller-identity   # 현재 로그인된 AWS 계정 확인

# Node.js & CDK — 인프라를 코드로 배포하는 도구
node --version    # >= 18
cdk --version     # >= 2.x

# kubectl & Helm — Kubernetes 클러스터를 관리하는 도구
kubectl version --client
helm version

# OSMO CLI — OSMO 워크플로를 제출하고 관리하는 도구
pip install nvidia-osmo
osmo version

# NGC API Key — NVIDIA GPU Cloud 레지스트리에서 이미지를 받기 위한 키
# https://org.ngc.nvidia.com/ 에서 발급받으세요
export NGC_API_KEY="your-ngc-api-key"
```

---

## Step 1. 인프라 배포 (CDK)

### 이 스텝에서 하는 일

AWS CDK(Cloud Development Kit)를 사용해 OSMO가 실행될 클라우드 인프라를 한 번에 생성합니다. 수동으로 AWS 콘솔에서 하나씩 만들 필요 없이, 코드 한 줄로 전체 환경이 만들어집니다.

OSMO는 다음 인프라가 필요합니다:
- **EKS (Kubernetes)** — OSMO 서비스와 워크플로 Pod가 실행되는 곳
- **RDS (PostgreSQL)** — 워크플로 메타데이터, 사용자 정보를 저장하는 데이터베이스
- **ElastiCache (Redis)** — 워크플로 작업 큐를 관리하는 메시지 브로커
- **S3** — 학습 데이터셋과 모델 체크포인트를 저장하는 오브젝트 스토리지

### 1.1 CDK 배포

```bash
cd osmo/cdk
npm install                    # CDK 의존성 설치
cdk deploy --context region=us-west-2 --require-approval never
```

> 배포 완료까지 약 20분 소요됩니다. EKS 클러스터 생성에 ~10분, RDS 생성에 ~8분이 걸립니다.

### 1.2 배포되는 리소스

| 리소스 | 사양 | 용도 |
|--------|------|------|
| EKS Cluster | Kubernetes v1.30 | OSMO 서비스 및 워크플로 실행 환경 |
| System Node Group | m5.xlarge × 2 | OSMO 서비스, Kai Scheduler 실행 |
| GPU-Train Node Group | g6e.12xlarge (4×L40S), 0~4대 | GR00T 모델 학습 |
| GPU-Sim Node Group | g5.12xlarge (4×A10G), 0~8대 | Isaac Sim 시뮬레이션 |
| RDS PostgreSQL | db.t3.medium | OSMO 메타데이터 저장 |
| ElastiCache Redis | cache.t3.medium | 작업 큐 관리 |
| S3 Bucket | Intelligent Tiering | 데이터셋/체크포인트 저장 |

> **참고:** GPU 노드그룹은 `desiredSize=0`으로 설정되어 있어 평소에는 비용이 발생하지 않습니다. 워크플로 실행 시에만 수동으로 스케일업합니다.

### 1.3 배포 결과 확인

```bash
# 노드그룹이 3개 생성되었는지 확인
aws eks list-nodegroups --cluster-name osmo-eks --region us-west-2
```

예상 출력:
```json
{
    "nodegroups": ["gpu-sim", "gpu-train", "system"]
}
```

---

## Step 2. Kubernetes 기본 설정

### 이 스텝에서 하는 일

EKS 클러스터에 GPU 워크로드를 실행하기 위한 기본 구성요소를 설치합니다. Kubernetes 자체는 GPU를 인식하지 못하므로, NVIDIA 플러그인을 설치해야 합니다.

### 2.1 kubeconfig 설정

`kubectl`이 우리 EKS 클러스터와 통신할 수 있도록 연결 정보를 설정합니다.

```bash
aws eks update-kubeconfig --name osmo-eks --region us-west-2
kubectl get nodes
```

예상 출력 (System 노드 2대가 Ready 상태):
```
NAME                                       STATUS   ROLES    AGE   VERSION
ip-10-0-1-xxx.us-west-2.compute.internal   Ready    <none>   5m    v1.30.x
ip-10-0-3-xxx.us-west-2.compute.internal   Ready    <none>   5m    v1.30.x
```

### 2.2 NVIDIA Device Plugin 설치

**왜 필요한가?** Kubernetes는 기본적으로 CPU와 메모리만 관리합니다. GPU를 리소스로 인식하고 Pod에 할당하려면 NVIDIA Device Plugin이 필요합니다. 이 플러그인이 설치되면 `nvidia.com/gpu: 1` 같은 리소스 요청이 가능해집니다.

```bash
kubectl apply -f https://raw.githubusercontent.com/NVIDIA/k8s-device-plugin/v0.14.5/nvidia-device-plugin.yml
```

설치 확인:
```bash
kubectl get daemonset -n kube-system nvidia-device-plugin-daemonset
```

### 2.3 NVIDIA RuntimeClass 생성

**왜 필요한가?** 컨테이너 안에서 `nvidia-smi`를 실행하거나 CUDA를 사용하려면, 컨테이너 런타임이 호스트의 GPU 드라이버를 컨테이너에 마운트해줘야 합니다. RuntimeClass를 `nvidia`로 지정하면 이 작업이 자동으로 수행됩니다.

```bash
kubectl apply -f - <<'EOF'
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: nvidia
handler: nvidia
EOF
```

확인:
```bash
kubectl get runtimeclass nvidia
```

---

## Step 3. OSMO 설치 (Helm)

### 이 스텝에서 하는 일

OSMO는 여러 마이크로서비스로 구성됩니다. Helm 차트를 사용해 이 서비스들을 Kubernetes에 배포합니다.

**OSMO 아키텍처:**
```
┌─ osmo-minimal 네임스페이스 ─────────────────────────┐
│  osmo-service  — CLI/API 엔드포인트                  │
│  osmo-agent    — 내부 작업 조율                      │
│  osmo-logger   — 워크플로 로그 수집 (ctrl sidecar)   │
│  osmo-worker   — 백그라운드 작업 처리                │
└──────────────────────────────────────────────────────┘
┌─ osmo-operator 네임스페이스 ─────────────────────────┐
│  backend-operator — 워크플로 Pod 생성/관리            │
└──────────────────────────────────────────────────────┘
┌─ kai-scheduler 네임스페이스 ─────────────────────────┐
│  kai-scheduler — NVIDIA GPU 스케줄러                  │
│  (Queue CRD로 GPU 쿼터 관리)                         │
└──────────────────────────────────────────────────────┘
┌─ osmo-workflows 네임스페이스 ────────────────────────┐
│  (사용자 워크플로 Pod가 여기서 실행됨)               │
└──────────────────────────────────────────────────────┘
```

### 3.1 네임스페이스 생성

각 컴포넌트가 실행될 Kubernetes 네임스페이스를 만듭니다.

```bash
kubectl create namespace osmo-minimal
kubectl create namespace osmo-operator
kubectl create namespace osmo-workflows
```

### 3.2 Helm 레포 추가

NVIDIA NGC 레지스트리에서 OSMO Helm 차트를 받을 수 있도록 레포를 등록합니다.

```bash
helm repo add osmo https://helm.ngc.nvidia.com/nvidia/osmo \
  --username '$oauthtoken' --password "${NGC_API_KEY}"
helm repo update
```

### 3.3 인프라 엔드포인트 확인

CDK가 생성한 RDS, Redis 주소를 가져옵니다. OSMO가 이 데이터베이스들에 연결해야 하므로 주소가 필요합니다.

```bash
POSTGRES_HOST=$(aws rds describe-db-instances \
  --query "DBInstances[?DBInstanceIdentifier=='osmo-postgres'].Endpoint.Address" \
  --output text --region us-west-2)

REDIS_HOST=$(aws elasticache describe-replication-groups \
  --query "ReplicationGroups[?ReplicationGroupId=='osmo-redis'].NodeGroups[0].PrimaryEndpoint.Address" \
  --output text --region us-west-2)

echo "PostgreSQL: $POSTGRES_HOST"
echo "Redis: $REDIS_HOST"
```

### 3.4 Kubernetes Secret 생성

**왜 필요한가?** 데이터베이스 패스워드 같은 민감 정보는 Helm values에 직접 넣지 않고 Kubernetes Secret으로 따로 관리합니다. OSMO Pod가 실행될 때 이 Secret을 참조합니다.

```bash
# PostgreSQL 접속 패스워드
kubectl create secret generic db-secret \
  --from-literal=db-password="YOUR_DB_PASSWORD" \
  --namespace osmo-minimal

# Redis 접속 패스워드
kubectl create secret generic redis-secret \
  --from-literal=redis-password="YOUR_REDIS_PASSWORD" \
  --namespace osmo-minimal

# Master Encryption Key (MEK) — OSMO 내부 토큰 암호화에 사용
MEK_KEY=$(openssl rand -base64 32 | tr -d '\n')
kubectl apply -f - <<EOF
apiVersion: v1
kind: ConfigMap
metadata:
  name: mek-config
  namespace: osmo-minimal
data:
  mek.yaml: |
    currentMek: key1
    meks:
      key1: '{"k":"${MEK_KEY}","kid":"key1","kty":"oct"}'
EOF
```

> **YOUR_DB_PASSWORD / YOUR_REDIS_PASSWORD**는 CDK 배포 시 `cdk.json` 또는 환경 변수로 지정한 값을 사용하세요.

### 3.5 NGC Pull Secret 생성

**왜 필요한가?** OSMO 컨테이너 이미지는 NVIDIA의 프라이빗 레지스트리(nvcr.io)에 호스팅됩니다. Kubernetes가 이미지를 pull하려면 인증 정보가 필요합니다.

```bash
# OSMO 서비스 네임스페이스
kubectl create secret docker-registry nvcr-secret \
  --namespace osmo-minimal \
  --docker-server=nvcr.io \
  --docker-username='$oauthtoken' \
  --docker-password="${NGC_API_KEY}"

# 워크플로 네임스페이스 (워크플로 Pod도 OSMO init-container를 pull함)
kubectl create secret docker-registry nvcr-secret \
  --namespace osmo-workflows \
  --docker-server=nvcr.io \
  --docker-username='$oauthtoken' \
  --docker-password="${NGC_API_KEY}"
```

### 3.6 OSMO Service 배포

OSMO의 핵심 서비스들을 배포합니다. values 파일로 RDS/Redis 연결 정보를 전달합니다.

```bash
cat > /tmp/service_values.yaml <<EOF
global:
  osmoImageLocation: nvcr.io/nvidia/osmo
  osmoImageTag: latest
  imagePullSecret: nvcr-secret

services:
  configFile:
    enabled: true

  postgres:
    enabled: false
    serviceName: ${POSTGRES_HOST}
    port: 5432
    db: osmo
    user: postgres
    passwordSecretName: db-secret
    passwordSecretKey: db-password

  redis:
    enabled: false
    serviceName: ${REDIS_HOST}
    port: 6379
    tlsEnabled: true

  agent:
    scaling:
      minReplicas: 1
      maxReplicas: 1

  logger:
    scaling:
      minReplicas: 1
      maxReplicas: 1

podMonitor:
  enabled: false
EOF

helm install osmo-minimal osmo/service \
  --namespace osmo-minimal \
  --values /tmp/service_values.yaml \
  --wait --timeout 10m
```

> `postgres.enabled: false`와 `redis.enabled: false`는 "OSMO가 자체 DB/Redis를 배포하지 않고, 외부(CDK가 만든) 것을 사용한다"는 뜻입니다.

### 3.7 Backend Operator 배포

**왜 필요한가?** Backend Operator는 사용자가 워크플로를 제출하면 실제 Kubernetes Pod를 생성하는 역할을 합니다. OSMO Service와 통신하기 위한 인증 토큰이 필요합니다.

```bash
# OSMO Service에 접속하여 operator용 토큰 발급
kubectl port-forward service/osmo-service 9001:9001 -n osmo-minimal &
sleep 5

osmo login --url http://localhost:9001 --dev-login

# Backend Operator가 사용할 서비스 토큰 생성
OPERATOR_TOKEN=$(osmo token set backend-token \
  --expires-at 2027-01-01 \
  --description "Backend Operator Token" \
  --service \
  --roles osmo-backend \
  -t json | jq -r '.token')

kill %1  # port-forward 종료

# 토큰을 Kubernetes Secret으로 저장
kubectl create secret generic osmo-operator-token \
  --from-literal=token="${OPERATOR_TOKEN}" \
  --namespace osmo-operator

# Operator 배포
cat > /tmp/operator_values.yaml <<EOF
global:
  osmoImageLocation: nvcr.io/nvidia/osmo
  osmoImageTag: latest
  accountTokenSecret: osmo-operator-token
  agentNamespace: osmo-operator
  backendName: default
  backendNamespace: osmo-workflows
  loginMethod: token
  serviceUrl: http://osmo-agent.osmo-minimal.svc.cluster.local

podMonitor:
  enabled: false

sidecars:
  otel:
    enabled: false
EOF

helm install osmo-operator osmo/backend-operator \
  --namespace osmo-operator \
  --values /tmp/operator_values.yaml \
  --wait --timeout 5m
```

### 3.8 Kai Scheduler 설치

**왜 필요한가?** NVIDIA Kai Scheduler는 여러 워크플로가 동시에 GPU를 요청할 때 공정하게 분배하는 스케줄러입니다. Queue CRD를 통해 팀/프로젝트별 GPU 쿼터를 설정할 수 있습니다.

```bash
helm install kai-scheduler osmo/kai-scheduler \
  --namespace kai-scheduler --create-namespace \
  --version 0.13.4
```

### 3.9 배포 확인

Helm 릴리스와 Pod 상태를 확인합니다.

```bash
# Helm 릴리스 확인 — 3개 차트가 모두 deployed 상태여야 합니다
helm list --all-namespaces
```

예상 출력:
```
NAME             NAMESPACE       STATUS     CHART
osmo-minimal     osmo-minimal    deployed   service-x.x.x
osmo-operator    osmo-operator   deployed   backend-operator-x.x.x
kai-scheduler    kai-scheduler   deployed   kai-scheduler-0.13.4
```

```bash
# OSMO 서비스 Pod (5개)
kubectl get pods -n osmo-minimal
```

예상 출력:
```
NAME                                        READY   STATUS    AGE
osmo-agent-xxx                              2/2     Running   2m
osmo-delayed-job-monitor-xxx                1/1     Running   2m
osmo-logger-xxx                             2/2     Running   2m
osmo-service-xxx                            2/2     Running   2m
osmo-worker-xxx                             1/1     Running   2m
```

```bash
# Kai Scheduler (7개)
kubectl get pods -n kai-scheduler

# Backend Operator (1개)
kubectl get pods -n osmo-operator
```

> 모든 Pod가 Running이 아니라면, `kubectl describe pod <pod-name> -n <namespace>`로 이벤트를 확인하세요.

---

## Step 4. OSMO 구성

### 이 스텝에서 하는 일

OSMO CLI를 통해 시스템을 설정합니다. OSMO가 S3에 접근하는 방법, 워크플로 로그를 어디에 저장할지, 어떤 GPU 플랫폼을 사용할지 등을 정의합니다.

**설정 흐름:**
```
IAM 사용자 생성 → Credential 등록 → Config 설정 → Queue 생성
                    (S3 접근키)        (저장소 경로)    (GPU 쿼터)
```

**런타임 동작:** Credential과 Config는 워크플로 실행 시 다음과 같이 사용됩니다:
- **Credential** (Step 4.3): 워크플로 Pod가 S3에 데이터를 읽고 쓸 때 OSMO가 이 키를 주입합니다
- **Config WORKFLOW** (Step 4.4): ctrl sidecar가 워크플로 로그와 결과물을 S3에 저장할 경로를 결정합니다
- **Config SERVICE**: ctrl sidecar가 작업 완료/실패 상태를 보고할 내부 URL을 지정합니다
- **Config POOL**: 워크플로의 `platform` 필드가 어떤 GPU 노드에 스케줄될지 매핑합니다
- Credential 없이 워크플로를 실행하면 `Workflow data credential is not set` 에러가 발생합니다

### 4.1 OSMO CLI 로그인

```bash
# Port-forward — kubectl을 통해 로컬에서 OSMO API에 접근할 수 있게 합니다
kubectl port-forward -n osmo-minimal svc/osmo-service 9001:9001 &

# dev-login — 개발 환경용 간편 로그인 (프로덕션에서는 OAuth 사용)
osmo login --url http://localhost:9001 --dev-login
```

> 로그인 후 `~/.config/osmo/login.yaml`에 연결 정보가 저장됩니다.

### 4.2 S3 접근용 IAM 사용자 생성

**왜 필요한가?** OSMO 워크플로는 S3에 학습 데이터를 읽고, 모델 체크포인트를 저장합니다. 이를 위한 전용 IAM 사용자와 Access Key가 필요합니다.

```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
BUCKET_NAME=$(aws s3api list-buckets \
  --query "Buckets[?starts_with(Name,'osmo-data')].Name" --output text)

echo "S3 Bucket: $BUCKET_NAME"

# OSMO 전용 IAM 사용자 생성
aws iam create-user --user-name osmo-workflow-user

# S3 접근 + SimulatePrincipalPolicy 권한 부여
# (OSMO가 credential 등록 시 SimulatePrincipalPolicy로 접근 권한을 검증합니다)
aws iam put-user-policy --user-name osmo-workflow-user \
  --policy-name osmo-s3-access \
  --policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [
      {
        \"Effect\": \"Allow\",
        \"Action\": [\"s3:*\"],
        \"Resource\": [
          \"arn:aws:s3:::${BUCKET_NAME}\",
          \"arn:aws:s3:::${BUCKET_NAME}/*\"
        ]
      },
      {
        \"Effect\": \"Allow\",
        \"Action\": [\"iam:SimulatePrincipalPolicy\"],
        \"Resource\": \"arn:aws:iam::${ACCOUNT_ID}:user/osmo-workflow-user\"
      }
    ]
  }"

# Access Key 발급
aws iam create-access-key --user-name osmo-workflow-user
```

> **출력된 `AccessKeyId`와 `SecretAccessKey`를 기록하세요.** 이후 단계에서 사용합니다.
>
> IAM 사용자가 생성된 직후에는 전파 지연(~10초)이 있을 수 있습니다. 다음 단계에서 에러가 나면 잠시 후 재시도하세요.

### 4.3 OSMO Credential 등록

**왜 필요한가?** OSMO에 S3 접근 키를 등록하면, 워크플로 실행 시 자동으로 이 키를 사용해 데이터를 읽고 씁니다.

```bash
osmo credential set DATA \
  --type DATA \
  --payload \
    access_key_id=YOUR_ACCESS_KEY_ID \
    access_key=YOUR_SECRET_ACCESS_KEY \
    endpoint=s3://${BUCKET_NAME} \
    region=us-west-2
```

> `YOUR_ACCESS_KEY_ID`와 `YOUR_SECRET_ACCESS_KEY`를 4.2에서 발급받은 값으로 교체하세요.

### 4.4 OSMO Config 설정

**왜 필요한가?** OSMO는 여러 설정 파일(Config)을 통해 동작을 제어합니다:
- **WORKFLOW** — 워크플로 실행 데이터와 로그를 어디에 저장할지
- **DATASET** — 학습 데이터셋 버킷 경로
- **SERVICE** — 내부 통신 URL (ctrl sidecar → logger)
- **POOL** — GPU 플랫폼 정의

```bash
# WORKFLOW 설정 — 워크플로 실행 데이터/로그 저장 경로
cat > /tmp/workflow-config.json <<EOF
{
  "workflow_data": {
    "credential": {
      "endpoint": "s3://${BUCKET_NAME}/workflows",
      "region": "us-west-2",
      "access_key_id": "YOUR_ACCESS_KEY_ID",
      "access_key": "YOUR_SECRET_ACCESS_KEY"
    },
    "websocket_timeout": 1440,
    "data_timeout": 10,
    "download_type": "download"
  },
  "workflow_log": {
    "credential": {
      "endpoint": "s3://${BUCKET_NAME}/logs",
      "region": "us-west-2",
      "access_key_id": "YOUR_ACCESS_KEY_ID",
      "access_key": "YOUR_SECRET_ACCESS_KEY"
    }
  }
}
EOF
osmo config update WORKFLOW --file /tmp/workflow-config.json

# DATASET 설정 — 학습 데이터셋이 저장될 S3 경로
cat > /tmp/dataset-config.json <<EOF
{
  "buckets": {
    "osmo": {
      "dataset_path": "s3://${BUCKET_NAME}/datasets",
      "region": "us-west-2",
      "mode": "read-write"
    }
  },
  "default_bucket": "osmo"
}
EOF
osmo config update DATASET --file /tmp/dataset-config.json

# SERVICE 설정 — ctrl sidecar의 상태 보고 대상 URL
# ctrl sidecar는 각 워크플로 Pod 안에서 실행되며, 작업 완료/실패 상태를 이 URL로 보고합니다
cat > /tmp/service-config.json <<EOF
{
  "service_base_url": "http://osmo-logger.osmo-minimal.svc.cluster.local"
}
EOF
osmo config update SERVICE --file /tmp/service-config.json

# POOL 설정 — 사용 가능한 GPU 플랫폼 정의
cat > /tmp/pool-config.json <<EOF
{
  "pools": {
    "default": {
      "name": "default",
      "description": "Default pool",
      "status": "ONLINE",
      "backend": "default",
      "default_platform": "gpu-train",
      "common_pod_template": ["default_ctrl", "default_user"],
      "platforms": {
        "gpu-train": {
          "description": "GPU training platform (L40S)",
          "default_variables": {"USER_GPU": 1}
        },
        "gpu-sim": {
          "description": "GPU simulation platform (A10G)",
          "default_variables": {"USER_GPU": 1}
        }
      }
    }
  }
}
EOF
osmo config update POOL --file /tmp/pool-config.json
```

> `YOUR_ACCESS_KEY_ID`와 `YOUR_SECRET_ACCESS_KEY`를 실제 값으로 교체하세요.

### 4.5 Kai Scheduler Queue 생성

**왜 필요한가?** Kai Scheduler는 Queue CRD로 GPU 리소스 쿼터를 관리합니다. Queue가 없으면 워크플로가 `QueueDoesNotExist` 에러로 실패합니다.

Queue 이름은 `osmo-pool-{workflow_namespace}-{pool_name}` 형식을 따릅니다.

```bash
kubectl apply -f - <<'EOF'
apiVersion: scheduling.run.ai/v2
kind: Queue
metadata:
  name: osmo-pool-osmo-workflows-default
  namespace: kai-scheduler
spec:
  parentQueue: default
  priority: 100
  resources:
    gpu:
      quota: 4
      limit: 8
    cpu:
      quota: 48000
      limit: 96000
    memory:
      quota: 192000000000
      limit: 384000000000
EOF
```

> `cpu`와 `memory`는 millicores와 bytes 단위입니다. 48000 = 48 cores, 192000000000 = ~192GB.

---

## Step 5. GPU 워크플로 검증

### 이 스텝에서 하는 일

간단한 `nvidia-smi` 워크플로를 실행하여 전체 파이프라인이 정상 동작하는지 확인합니다. 이 테스트가 성공하면:
- OSMO CLI → OSMO Service → Backend Operator → Pod 생성 경로가 정상
- Kai Scheduler가 GPU 리소스를 올바르게 할당
- RuntimeClass nvidia가 GPU 드라이버를 컨테이너에 주입
- ctrl sidecar가 워크플로 상태를 정상 보고

### 5.1 GPU 노드 스케일업

GPU 노드그룹은 비용 절감을 위해 0대로 설정되어 있습니다. 워크플로 실행 전에 수동으로 1대를 켭니다.

```bash
aws eks update-nodegroup-config \
  --cluster-name osmo-eks \
  --nodegroup-name gpu-train \
  --scaling-config minSize=0,maxSize=4,desiredSize=1 \
  --region us-west-2
```

노드가 Ready될 때까지 약 2~3분 기다립니다:

```bash
# -w 옵션으로 실시간 상태 변화를 관찰합니다
kubectl get nodes -l node-role=gpu-train -w
```

`STATUS`가 `Ready`로 바뀌면 Ctrl+C로 종료합니다.

### 5.2 GPU 테스트 워크플로 제출

OSMO 워크플로는 YAML 파일로 정의합니다. 가장 간단한 형태의 GPU 워크플로를 실행해봅니다.

```bash
cat > /tmp/gpu-test.yaml <<'EOF'
workflow:
  name: gpu-test
  resources:
    default:
      cpu: 4
      gpu: 1
      memory: 8Gi
      storage: 10Gi
      platform: gpu-train
  tasks:
  - name: gpu-check
    image: nvidia/cuda:12.8.0-base-ubuntu22.04
    command: ["nvidia-smi"]
EOF

osmo workflow submit /tmp/gpu-test.yaml
```

> `platform: gpu-train`은 Step 4.4에서 정의한 GPU 플랫폼을 지정합니다.

### 5.3 결과 확인

```bash
# 워크플로 상태 확인 (COMPLETED가 될 때까지 반복)
osmo workflow query gpu-test-1

# 로그 확인 — nvidia-smi 출력이 보여야 합니다
osmo workflow logs gpu-test-1
```

예상 출력:
```
Workflow ID : gpu-test-1
Status      : COMPLETED

Task Name    Start Time               Status
=============================================
gpu-check    ...                      COMPLETED
```

로그에서 GPU 정보 확인:
```
NVIDIA L40S | Driver: 570.x | CUDA: 12.8 | 46068MiB
```

> **문제 해결:** `SCHEDULING` 상태에서 멈춰 있다면 GPU 노드가 아직 Ready되지 않은 것입니다. `kubectl get nodes -l node-role=gpu-train`으로 확인하세요.

---

## Step 6. GR00T Fine-tuning 실행

### 이 스텝에서 하는 일

[NVIDIA Isaac GR00T](https://github.com/NVIDIA/Isaac-GR00T)는 로봇을 위한 Foundation Model입니다. 이 워크플로는 GR00T 모델을 demo 데이터셋으로 fine-tuning합니다.

**Fine-tuning이란?** 사전 학습된 대형 모델을 특정 작업(예: 물건 집기)에 맞게 추가 학습하는 과정입니다. 전체 모델을 처음부터 학습하는 것보다 훨씬 적은 데이터와 시간으로 좋은 성능을 얻을 수 있습니다.

이 워크플로는:
1. PyTorch 컨테이너에서 Isaac-GR00T 코드를 clone
2. 필요한 Python 패키지 설치
3. demo 데이터셋(robot_sim.PickNPlace)으로 100 step 학습
4. Fine-tuned 모델을 저장

### 6.1 워크플로 파일 작성

```bash
cat > /tmp/groot-finetune.yaml <<'EOF'
workflow:
  name: groot-finetune
  resources:
    default:
      cpu: 4
      gpu: 1
      memory: 32Gi
      storage: 100Gi
      platform: gpu-train
  tasks:
  - name: groot-finetune
    image: pytorch/pytorch:2.6.0-cuda12.4-cudnn9-devel
    command: ["/bin/bash"]
    args: ["/tmp/entry.sh"]
    environment:
      DEBIAN_FRONTEND: 'noninteractive'
      WANDB_MODE: 'disabled'
    files:
    - contents: |-
        set -ex
        export GROOT_DIR=/workspace/Isaac-GR00T

        apt-get update || true
        apt-get install -y --no-install-recommends \
            git git-lfs libgl1-mesa-glx libglib2.0-0 \
            libsm6 libxext6 libxrender-dev build-essential cmake wget curl || true

        git clone https://github.com/NVIDIA/Isaac-GR00T.git $GROOT_DIR
        cd $GROOT_DIR
        git checkout 796ca8d87360913c47e9f75e17c11d63f7805048

        pip install --upgrade setuptools
        pip install gpustat wandb==0.19.0
        pip install -e ".[base]"

        pip uninstall -y transformer-engine || true
        pip install flash_attn==2.7.1.post4 -U --force-reinstall
        pip uninstall -y opencv-python opencv-python-headless || true
        pip install opencv-python==4.8.0.74
        pip install --force-reinstall torch==2.5.1 torchvision==0.20.1 torchaudio==2.5.1 numpy==1.26.4

        pip install -e . --no-deps
        pip install "accelerate>=0.26.0"

        nvidia-smi

        # Kubernetes의 /dev/shm 크기 제한(64MB) 우회
        mount -o remount,size=8G /dev/shm 2>/dev/null || true

        python scripts/gr00t_finetune.py \
          --dataset-path ./demo_data/robot_sim.PickNPlace \
          --num-gpus 1 \
          --max-steps 100 \
          --output-dir /tmp/finetuned-model \
          --data-config fourier_gr1_arms_only \
          --dataloader_num_workers 0

        echo "=== Training complete ==="
        ls -la /tmp/finetuned-model/

      path: /tmp/entry.sh
EOF
```

**워크플로 YAML 구조 설명:**
- `resources.default` — 워크플로에 할당할 리소스 (CPU, GPU, 메모리, 디스크)
- `tasks[].image` — 실행할 컨테이너 이미지
- `tasks[].files` — 컨테이너 안에 생성할 파일 (여기서는 학습 스크립트)
- `tasks[].environment` — 환경 변수
- `WANDB_MODE: disabled` — Weights & Biases 로깅 비활성화 (API 키 불필요)
- `--dataloader_num_workers 0` — Kubernetes /dev/shm 64MB 제한 우회

### 6.2 워크플로 제출

```bash
osmo workflow submit /tmp/groot-finetune.yaml
```

### 6.3 모니터링

```bash
# 전체 상태 확인
osmo workflow query groot-finetune-1

# 실시간 로그 확인
osmo workflow logs groot-finetune-1

# Pod 상태 확인
kubectl get pods -n osmo-workflows -w
```

### 6.4 완료 확인

전체 소요 시간: 약 15분
- 이미지 풀: ~2분 (pytorch 이미지 7.4GB)
- 의존성 설치: ~8분 (pip install)
- 학습 (100 steps): ~5분 (~3초/step)

```bash
osmo workflow query groot-finetune-1
```

예상 출력:
```
Workflow ID : groot-finetune-1
Status      : COMPLETED

Task Name        Start Time               Status
================================================
groot-finetune   ...                      COMPLETED
```

로그에서 학습 결과 확인:
```bash
osmo workflow logs groot-finetune-1
```

예상 출력:
```
100%|██████████| 100/100 [04:53<00:00, 2.92s/it]
{'train_runtime': 379.34, 'train_samples_per_second': 8.44, 'train_loss': 0.137}
=== Training complete ===
model.safetensors.index.json
trainer_state.json
training_args.bin
```

### 6.5 GPU 노드 스케일다운

워크플로가 완료되면 비용 절감을 위해 GPU 노드를 0대로 되돌립니다.

```bash
aws eks update-nodegroup-config \
  --cluster-name osmo-eks \
  --nodegroup-name gpu-train \
  --scaling-config minSize=0,maxSize=4,desiredSize=0 \
  --region us-west-2
```

---

## Step 7. 정리 (Cleanup)

실습이 끝나면 비용이 발생하지 않도록 리소스를 삭제합니다.

### 7.1 OSMO Helm 릴리스 삭제

```bash
helm uninstall osmo-minimal -n osmo-minimal
helm uninstall osmo-operator -n osmo-operator
helm uninstall kai-scheduler -n kai-scheduler
```

### 7.2 네임스페이스 삭제

```bash
kubectl delete namespace osmo-minimal osmo-operator osmo-workflows kai-scheduler
```

### 7.3 IAM 리소스 정리

```bash
# Access Key 삭제
ACCESS_KEY_ID=$(aws iam list-access-keys --user-name osmo-workflow-user \
  --query 'AccessKeyMetadata[0].AccessKeyId' --output text)
aws iam delete-access-key --user-name osmo-workflow-user --access-key-id $ACCESS_KEY_ID

# Policy 삭제
aws iam delete-user-policy --user-name osmo-workflow-user --policy-name osmo-s3-access

# 사용자 삭제
aws iam delete-user --user-name osmo-workflow-user
```

### 7.4 CDK 스택 삭제

```bash
cd osmo/cdk
cdk destroy --context region=us-west-2
```

> CDK destroy는 약 15분 소요됩니다. EKS 클러스터 삭제가 가장 오래 걸립니다.

---

## Troubleshooting

| 증상 | 원인 | 해결 |
|------|------|------|
| Pod가 `SCHEDULING`에서 멈춤 | GPU 노드가 0대 | Step 5.1로 스케일업 |
| `RuntimeClass nvidia not found` | RuntimeClass 미생성 | Step 2.3 실행 |
| OSMO CLI가 404 반환 | 잘못된 포트 포워딩 | `svc/osmo-service` 포트 9001 확인 |
| `Workflow data credential is not set` | OSMO credential 미설정 | Step 4.3 실행 |
| `QueueDoesNotExist` | Kai Queue 미생성 | Step 4.5 실행 |
| `No space left on device` (학습 중) | /dev/shm 64MB 제한 | `--dataloader_num_workers 0` 추가 |
| `wandb.errors.UsageError` | wandb API 키 없음 | `WANDB_MODE: disabled` 환경변수 추가 |
| `InvalidClientTokenId` | IAM 키 전파 지연 | 10초 후 재시도 |
| `SimulatePrincipalPolicy` 에러 | IAM 정책 누락 | Step 4.2의 정책에 해당 권한 포함 확인 |
| 이미지 풀 실패 (nvcr.io) | NGC secret 미생성 | Step 3.5 실행 |
| `InsufficientInstanceCapacity` | GPU 인스턴스 리전 재고 부족 | 다른 인스턴스 타입 또는 리전 사용 |

---

## 아키텍처 요약

```
                    ┌─────────────────────────────────────────┐
                    │           VPC (10.0.0.0/16)              │
                    │                                         │
                    │  ┌─ Public Subnets ──────────────────┐  │
                    │  │  NAT Gateway    Internet Gateway   │  │
                    │  └───────────────────────────────────┘  │
                    │                                         │
                    │  ┌─ Private Subnets ─────────────────┐  │
                    │  │                                   │  │
                    │  │  ┌─ EKS Cluster (osmo-eks) ────┐  │  │
                    │  │  │                             │  │  │
                    │  │  │  System (m5.xlarge ×2)      │  │  │
                    │  │  │    └─ OSMO Service Pods     │  │  │
                    │  │  │    └─ Kai Scheduler         │  │  │
                    │  │  │                             │  │  │
                    │  │  │  GPU-Train (g6e.12xlarge)   │  │  │
                    │  │  │    └─ GR00T Fine-tuning     │  │  │
                    │  │  │    └─ 4× NVIDIA L40S        │  │  │
                    │  │  │                             │  │  │
                    │  │  │  GPU-Sim (g5.12xlarge)      │  │  │
                    │  │  │    └─ Isaac Sim             │  │  │
                    │  │  │    └─ 4× NVIDIA A10G        │  │  │
                    │  │  └─────────────────────────────┘  │  │
                    │  │                                   │  │
                    │  │  RDS PostgreSQL    ElastiCache     │  │
                    │  │  (메타데이터)       (작업 큐)       │  │
                    │  └───────────────────────────────────┘  │
                    └─────────────────────────────────────────┘
                                        │
                                   S3 Bucket
                          (데이터셋 / 모델 체크포인트)
```

### 워크플로 실행 흐름

```
사용자                OSMO Service        Backend Operator      Kubernetes
  │                      │                      │                   │
  │ osmo workflow submit │                      │                   │
  │─────────────────────>│                      │                   │
  │                      │  워크플로 등록        │                   │
  │                      │─────────────────────>│                   │
  │                      │                      │  Pod 생성          │
  │                      │                      │──────────────────>│
  │                      │                      │                   │
  │                      │                      │  Kai Scheduler     │
  │                      │                      │  GPU 할당 & 스케줄 │
  │                      │                      │                   │
  │                      │    ctrl sidecar       │   학습 실행       │
  │                      │<─────────────────────────────────────────│
  │                      │    상태 보고          │                   │
  │                      │                      │                   │
  │ osmo workflow query  │                      │                   │
  │─────────────────────>│  COMPLETED           │                   │
  │<─────────────────────│                      │                   │
```
