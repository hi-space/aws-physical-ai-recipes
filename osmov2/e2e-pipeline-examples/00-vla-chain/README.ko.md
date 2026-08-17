# Stage 0 — VLA 체인 (한 번 제출: 01 → 03 → 04)

SO-101 GR00T VLA 체인의 단일 제출(single-submit) 버전입니다. 데이터 준비 → GR00T
파인튜닝 → LeIsaac closed-loop 평가를 **하나의** 워크플로 안 세 개 task로 묶고
OSMO task 의존성으로 연결했으므로, 한 번 제출하면 OSMO가 스스로 DAG를 진행합니다.

이 디렉터리의 모든 스테이지가 아니라 VLA 체인만 담고 있습니다. Stage 2(H1 휴머노이드
RL)는 이 데이터셋들을 주지도 받지도 않는 독립 트랙이고, Stage 5(edge)는 OSMO
워크플로가 아니라 Greengrass 배포이며, Stage 6(Cosmos 증강)은 선택 사항이라
타임아웃을 관리 가능한 범위로 두기 위해 제외했습니다. Stage 4 자체가 시뮬레이션
단계(Isaac Sim + LeIsaac rollout)이므로, 이 체인에도 시뮬레이션은 포함되어 있습니다 —
RL 트랙만 빠진 것입니다.

> 이 문서는 [README.md](README.md)(영문)의 한국어 번역본입니다.

```
prepare (CPU) ──▶ gr00t-finetune (GPU) ──▶ eval (GPU)
01-data-prep         03-vla-finetune      04-closeloop
```

- OSMO 입력: 없음 (Hugging Face에서 데이터셋을 직접 내려받음)
- OSMO 출력: `e2e-vla-chain-lerobot-dataset`,
  `e2e-vla-chain-groot-checkpoint`, `e2e-vla-chain-closeloop-artifacts`

출력 데이터셋 이름을 스테이지별 `e2e-pipeline-*`와 일부러 다르게 두었습니다.
체인 실행이 개별 스테이지 실행 산출물을 덮어쓰지 않도록 하기 위함입니다.

## 개별 스테이지 워크플로와의 차이

[`01-data-prep`](../01-data-prep/README.ko.md),
[`03-vla-finetune`](../03-vla-finetune/README.ko.md),
[`04-closeloop`](../04-closeloop/README.ko.md)이 여전히 정본(authoritative)이며
단독 실행 가능한 버전입니다. 이 파일은 그 task 본문을 복사한 것입니다.

| | 개별 스테이지 (01/03/04) | 이 파일 |
| --- | --- | --- |
| 제출 횟수 | 3회, 앞 단계 완료를 기다려야 함 | 1회 |
| 연결 방식 | 데이터셋 이름 (`--set input_dataset=…`) | `inputs: - task: <name>` |
| 재시작 단위 | 실패한 스테이지만 재실행 | 워크플로 전체 (아래 참고) |
| 적합한 용도 | 개발, 디버깅, 부분 재실행 | 무인 end-to-end 실행 |

한 단계를 반복 수정 중이라면 스테이지 디렉터리를 쓰고, 사람 개입 없이 전체 체인을
돌리려면 이 파일을 쓰세요.

묶어서 돌리는 실질적 비용은 재시작 단위입니다. `osmo workflow restart`는
workflow id만 받고 task 선택 인자가 없으므로, `eval`이 실패했을 때
`04-closeloop`을 재제출하듯 그 task만 다시 돌릴 수 없습니다. 게다가 restart가 이미
완료된 `gr00t-finetune` task를 다시 돌리는지는 검증되지 않았습니다 — 다시 돈다고
가정하세요. `train_max_steps`를 실제 값으로 올린 상태라면 GPU 수 시간이 날아갈 수
있으므로, 설정이 아직 검증되지 않은 동안은 스테이지별 경로를 쓰고 전체 실행이 한 번
성공한 뒤에 이 파일로 옮겨가는 편이 안전합니다.

## 변수 prefix

`default-values`는 평면(flat) 네임스페이스 하나뿐이라 모든 변수에 스테이지 prefix를
붙였습니다: `prep_*`, `train_*`, `eval_*`. 이 덕분에 서로 다른 두 개의 pin된
Isaac-GR00T ref가 한 워크플로에 공존할 수 있습니다 — `train_gr00t_ref`
(`ead52833…`, 파인튜닝용 pin)와 `eval_gr00t_ref` (`e8e625f4…`, leisaac N1.6 ZMQ
서버 호환 pin). 나머지 knob은 원본 세 스테이지에서 이름만 바뀐 채 그대로 옵니다.

## 타임아웃

`exec_timeout`은 task별이 아니라 워크플로 단위이므로 체인 전체를 덮어야 합니다:
2h(prep) + 12h(train) + 4h(eval) + 노드 프로비저닝 여유 → `20h`.
`train_max_steps`를 크게 올리면 이 값도 함께 올리세요.

이 값은 원본 스테이지들의 상한을 더한 것이고 예상 실행 시간이 아닙니다 — 10000
스텝 실행은 이보다 훨씬 짧게 끝납니다. [대략 걸리는 시간](#대략-걸리는-시간) 참고.

## 실행

두 GPU task 모두 기본 platform은 `g6e-l40s`입니다. 학습 task가 요청량이 더 크므로
(`cpu: 16` / `memory: 96Gi`) `g6e.8xlarge`를 prewarm 하면 되고, 평가 task는 같은
NodePool에 들어갑니다.

```bash
GPU_PREWARM_INSTANCE_TYPE=g6e.8xlarge scripts/prewarm-gpu-node.sh

osmo workflow submit e2e-pipeline-examples/00-vla-chain/workflow.yaml \
  --set prep_hf_dataset_id=LightwheelAI/leisaac-pick-orange \
        train_max_steps=10000 train_save_steps=10000

scripts/wait-gpu-node-cleanup.sh
```

override는 반드시 **하나의** `--set` 뒤에 `k=v`를 공백으로 나열하세요. `--set`
플래그를 여러 번 반복하면 OSMO CLI(6.3.x)가 마지막 것만 반영하고 나머지를 조용히
버립니다. 전체 실행은 세 스테이지 변수를 한꺼번에 override 하므로 개별 스테이지보다
이 함정이 더 위험합니다. 실제 렌더된 값은
`osmo workflow submit … --dry-run 2>&1 | grep -E 'platform|max_steps'`로 확인하세요.

두 GPU task를 96GB g7e(RTX PRO 6000)로 옮기려면 — g7e NodePool은 항상 배포되어
있으므로 재배포가 필요 없습니다:

```bash
GPU_PREWARM_INSTANCE_TYPE=g7e.8xlarge scripts/prewarm-gpu-node.sh

osmo workflow submit e2e-pipeline-examples/00-vla-chain/workflow.yaml \
  --set train_platform=g7e-rtx-pro-6000 eval_platform=g7e-rtx-pro-6000
```

`train_max_steps` 기본값은 Stage 3에서 물려받은 smoke 값 `10`입니다. 평가 결과가
의미를 가지려면 실제 예산이 필요합니다 — `train_global_batch_size: 1`에서 `10000`
스텝은 L40S 한 장으로 약 1h(아래 참고)이고, prep/eval을 합쳐도 20h `exec_timeout`
안에 넉넉히 들어갑니다.

## 대략 걸리는 시간

2026-08-11 `us-east-1` 클러스터에서 측정했습니다. L40S 한 장(플랫폼 `g6e-l40s`,
노드 `g6e.16xlarge`), `train_global_batch_size: 1`, `train_max_steps: 10000`,
60 에피소드 `LightwheelAI/leisaac-pick-orange` 데이터셋 기준입니다.

| Task | 실제 작업 전 준비 시간 | 작업 자체 |
| --- | --- | --- |
| `prepare` | 무시할 수준 | 약 1.5분 (60 에피소드 → LeRobot v2.1, 666 MiB) |
| `gr00t-finetune` | 약 7분 (이미지 pull, Isaac-GR00T clone, N1.6 3B 다운로드) | `train_global_batch_size: 1`에서 2.54 samples/s → 10000 스텝에 약 66분 |
| `eval` | 약 13분 (apt, leisaac + lerobot 설치, flash-attn, Isaac Sim 에셋) | 에피소드당 약 4분20초 → 기본값 5개에 약 22분 (Stage 4의 `exec_timeout`은 4h) |

준비 시간은 task마다 한 번씩 들고 `train_max_steps`와 거의 무관하므로, 10 스텝
smoke 기본값도 학습 task에서 약 8분은 씁니다. 이 고정 비용이 예산을 지배합니다 —
prep + 두 task의 준비 시간 + 5 에피소드 eval만으로 학습 전에 약 48분이 나갑니다.

따라서 2h 안에 끝내야 하는 체인은 학습 루프에 약 70분을 쓸 수 있습니다. 측정된
처리량으로는 60 에피소드 데이터셋 약 2 에폭에 해당합니다 — 배치별 수치는
[Stage 3의 예산 표](../03-vla-finetune/README.ko.md#실제-런-예산-잡기)를 보고,
스텝 수가 아니라 `global_batch_size × max_steps`(본 샘플 수)로 계획하세요.

노드 크기를 키워도 큰 차이는 없습니다 — 학습은 L40S 한 장에 병목이 있고,
`g6e.16xlarge`는 권장 `g6e.8xlarge`보다 vCPU만 남는 구성이었습니다.

## task 연결 상세

각 task의 출력 디렉터리가 다음 task의 `{{input:0}}`로 마운트되므로, 데이터셋 입력
방식과 경로가 약간 다릅니다.

| Task | 읽는 경로 | 쓰는 경로 |
| --- | --- | --- |
| `prepare` | Hugging Face | `{{output}}/artifacts/dataset` |
| `gr00t-finetune` | `{{input:0}}/artifacts/dataset` | `{{output}}/artifacts/checkpoint-N` |
| `eval` | `{{input:0}}/artifacts` (가장 큰 `checkpoint-*`) | `{{output}}/artifacts/{eval-summary.json,logs/}` |

두 소비자 task 모두 원본 스테이지의 탐색 fallback(입력 루트 아래에서
`meta/info.json` / `config.json`을 찾는 로직)을 그대로 유지하므로, OSMO가 마운트
구조를 다르게 중첩해도 동작합니다.

## 요구사항

구성 스테이지들과 동일합니다.

- 데이터셋 다운로드와 `nvidia/GR00T-N1.6-3B` 베이스 모델용
  `huggingface_token` OSMO credential (`HF_TOKEN`).
- 제출 전에 용량이 보이는 GPU NodePool. 배포 시
  `DEPLOY_G6E_NODEPOOL=true OSMO_CONFIGURE_G6E_PLATFORM=true`로 g6e를 활성화하세요.
  [docs/gpu-capacity.md](../../docs/gpu-capacity.md) 참고.

## 상태

런타임 관련 세 스테이지에서 task 본문을 그대로 복사해 구조적으로 파생했습니다
(변수 이름, `inputs:` 연결, 입력 경로 두 곳만 다릅니다). 연결 메커니즘 자체 —
한 워크플로 안의 `inputs: - task: <name>` — 는
[`examples/sequential-policy`](../../examples/sequential-policy/README.ko.md)가
쓰는 것과 같습니다.

GPU end-to-end 런타임 검증 완료(`g6e-l40s`, 2026-08-11). 세 task 전부 COMPLETED이고
OSMO가 개입 없이 DAG를 진행했습니다. 두 번 돌려야 했습니다 — 첫 실행은 `eval`에서
실패했는데, 연결된 체크포인트 디렉터리 루트에 모델의 부분 복사본이 있어
`config.json`으로 탐색하면 잘못된 디렉터리를 고르기 때문입니다. 이제
`processor_config.json`으로 탐색합니다. [validation/validation.md](validation/validation.md)
참고.

두 실행 모두 `success_rate`는 `0.0`이었습니다. 연결(chaining) 자체를 가리키는 근거는
없고, 가장 유력한 설명은 학습량이 너무 적었다는 것이지만 더 큰 실행으로 확인하지는
못했습니다. 무엇을 배제했는지는 검증 노트를 참고하세요.
