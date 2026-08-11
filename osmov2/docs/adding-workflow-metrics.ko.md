# 파이프라인별 지표를 Grafana에 추가하기

GPU 워크플로우는 DCGM GPU 지표(util/VRAM/power/temp)가 `AWS OSMO Overview`
Grafana 대시보드에 자동으로 표시됩니다. 이 가이드는 loss, learning rate, epoch,
reward 같은 학습 스칼라를 같은 Grafana로 push해서, 한 실행의 학습 곡선을 그 실행의
GPU 곡선 옆에 놓는 방법을 다룹니다.

English: [adding-workflow-metrics.md](adding-workflow-metrics.md).

## 왜 Pushgateway인가 (scrape / MLflow 대신)

학습 잡은 ephemeral pod라 Prometheus가 안정적으로 scrape하기 어렵고, HF Trainer는
스칼라를 stdout에만 찍습니다. 그래서 워크플로우가 in-cluster Prometheus
Pushgateway로 스칼라를 push하고, Prometheus가 게이트웨이를 scrape해 AMP로
remote-write하며, Grafana가 AMP를 읽습니다. 예전 MLflow / TensorBoard UI 습관을
대체하는 경로로, 숫자가 Prometheus gauge로 들어와 다른 지표처럼 쿼리/패널링할 수
있습니다.

Pushgateway는 두 observability 스크립트가 배포합니다:
- `scripts/deploy-observability.sh` (AMP + AMG 경로)
- `scripts/deploy-observability-incluster.sh` (self-hosted Prometheus/Grafana)

canonical 서비스(`versions.yaml`):
`aws-osmo-pushgateway-prometheus-pushgateway.monitoring.svc.cluster.local:9091`

## 이 레포의 두 가지 push 패턴

| 패턴 | 사용 시점 | 참고 |
| --- | --- | --- |
| stdout 파싱(tee) | 트레이너가 스칼라 dict를 stdout에 찍음(HF Trainer) | `e2e-pipeline-examples/03-vla-finetune/workflow.yaml` |
| 파일 export | 지표가 파일로만 존재(TensorBoard event 파일) | `examples/isaaclab-rsl-rl-video/workflow-g6.yaml` |

대부분의 GR00T / HF-Trainer 스테이지는 아래 stdout 패턴을 씁니다. TensorBoard
event 파일이면 Isaac Lab 예제를 참고하세요(`export_tensorboard_scalars.py` 실행 후
각 스칼라 마지막 값을 게이트웨이로 curl).

## 빠른 시작 (stdout 패턴)

OSMO 워크플로우는 파일을 인라인(`files: contents:`)으로만 임베드합니다 — 호스트
include가 없어 pusher를 각 워크플로우에 복사해 넣어야 합니다. 복사 원본(canonical)은
[`scripts/push_metrics.py`](../scripts/push_metrics.py)이며, stdlib만 쓰고 prefix를
설정할 수 있고, `PUSHGATEWAY_URL`이 비면 순수 tee(무동작)입니다.

1. `scripts/push_metrics.py` 내용을 워크플로우의 `files:` 블록에 붙여넣기:

   ```yaml
   files:
   - path: /tmp/push_metrics.py
     contents: |
       # <scripts/push_metrics.py 내용을 contents: 아래 들여쓰기해서 붙여넣기>
   ```

2. 태스크 스크립트 상단에서 env 값 설정:

   ```bash
   PUSHGATEWAY_URL="{{ pushgateway_url }}"   # 비면 순수 tee, push 안 함
   METRICS_JOB="my_stage_training"           # Prometheus job 라벨 (스테이지당 하나)
   METRICS_PREFIX="my_stage"                 # => my_stage_loss, my_stage_epoch, ...
   WORKFLOW_ID="${HOSTNAME}"                 # {workflow=...} 라벨; 실행당 시리즈 하나
   ```

3. 트레이너 stdout을 pusher로 파이프. `set -o pipefail`(e2e 스테이지엔 이미 켜짐)이
   트레이너 exit status를 유지합니다:

   ```bash
   uv run python train.py ... 2>&1 \
     | PUSHGATEWAY_URL="${PUSHGATEWAY_URL}" METRICS_JOB="${METRICS_JOB}" \
       METRICS_PREFIX="${METRICS_PREFIX}" WORKFLOW_ID="${WORKFLOW_ID}" \
       python3 -u /tmp/push_metrics.py
   ```

4. 워크플로우 `default-values:`에 기본값 추가 — AMP 경로 실행은 push하고,
   observability 없는 실행은 순수 tee로 자연스럽게 떨어집니다:

   ```yaml
   default-values:
     pushgateway_url: "http://aws-osmo-pushgateway-prometheus-pushgateway.monitoring.svc.cluster.local:9091"
   ```

끝입니다. pusher는 HF-Trainer 스칼라 dict
(`{'loss': ..., 'learning_rate': ..., 'grad_norm': ..., 'epoch': ...}`)를 파싱해
`<prefix>_loss`, `<prefix>_learning_rate`, `<prefix>_grad_norm`, `<prefix>_epoch`,
`<prefix>_global_step`을 내보내며, 모두 `{job="<METRICS_JOB>", workflow="<id>"}`
라벨이 붙습니다.

추가 스칼라 키를 잡으려면 `push_metrics.py`의 `KEY_MAP`에 행을 추가하세요.

## Grafana 패널 추가

GR00T 스테이지 패널은 `scripts/deploy-observability.sh`의
`import_aws_osmo_overview_dashboard`("GR00T training scalars" row, 패널 id 11–15)에
있습니다. 새 스테이지 지표를 띄우려면 여기에 timeseries 패널을 추가하세요:

```json
{ "type": "timeseries", "title": "My stage loss",
  "datasource": {"type": "prometheus", "uid": "$datasource_uid"},
  "targets": [{"refId": "A",
    "expr": "my_stage_loss{job=\"my_stage_training\"}",
    "legendFormat": "{{workflow}}"}] }
```

`scripts/deploy-observability.sh`를 다시 실행하면 대시보드가 재import됩니다(uid로
upsert라 기존 패널은 보존/덮어쓰기).

## 확인

학습 중에 gauge가 AMP까지 도달했는지 확인하세요. AMP를 SigV4로 직접 쿼리하거나
(region us-east-1), 그냥 `AWS OSMO Overview` 대시보드를 여세요:

```bash
# Grafana Explore가 제일 쉬움: expr = my_stage_loss{job="my_stage_training"}
# 또는 AMP에 SigV4 서명 GET:
#   <amp_prometheus_endpoint>/api/v1/query?query=my_stage_loss
```

GR00T 스테이지 라이브 검증 값 예:
`groot_train_loss=1.1076`, `groot_learning_rate=3.02e-06`, `groot_grad_norm=2.6554`.

## 함정

- `pushgateway_url` 빈 값 = 순수 tee(지표 없음). 의도된 동작으로, AMP+AMG 경로(use1이
  여기)에서도 Pushgateway가 배포돼 있어야 합니다 — `deploy-observability.sh`가
  배포합니다. Pushgateway 없는 클러스터를 가리키면 `pushgateway_url=""`로 두어 push
  경고 노이즈를 피하세요.
- `epoch`는 full epoch 경계를 넘어야 나타납니다. 짧은 smoke 실행(`max_steps=10`)은
  `<prefix>_loss`는 있어도 `<prefix>_epoch`는 없습니다.
- 스테이지당 `METRICS_JOB` 하나를 유지하면 패널 필터링이 됩니다. 여러 스테이지가 같은
  job을 재사용하면 시리즈가 한 라벨 아래 섞입니다.
