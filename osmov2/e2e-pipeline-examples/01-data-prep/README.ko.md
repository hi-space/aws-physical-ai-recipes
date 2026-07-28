# Stage 1 — 데이터 준비

Hugging Face에서 LeRobot 데이터셋을 다운로드하고, 필요하면 LeRobot v3 → v2.1로
자동 변환한 뒤 검증하고, 학습 스테이지용 OSMO 데이터셋으로 게시합니다. CPU 전용
OSMO 태스크로 실행됩니다.

> 이 문서는 [README.md](README.md)(영문)의 한국어 번역본입니다.

- OSMO 입력: 없음 (Hugging Face에서 받음)
- OSMO 출력: `e2e-pipeline-lerobot-dataset` (Stage 3가 소비)

## 실행

```bash
osmo workflow submit e2e-pipeline-examples/01-data-prep/workflow.yaml \
  --set hf_dataset_id=LightwheelAI/leisaac-pick-orange
```

CPU 전용이라 GPU 프리워밍은 필요 없습니다.

## 파라미터 (default-values)

| 파라미터 | 기본값 | 설명 |
| --- | --- | --- |
| `hf_dataset_id` | `LightwheelAI/leisaac-pick-orange` | 다운로드할 Hugging Face 데이터셋 |
| `default_task` | `pick up the orange and place it on the plate` | 데이터셋에 기록되는 task/instruction 문자열 |
| `output_dataset` | `e2e-pipeline-lerobot-dataset` | OSMO 출력 데이터셋 이름 |
| `cpu` / `memory` / `storage` | `4` / `16Gi` / `12Gi` | Pod 리소스 |

## 하는 일

1. Hugging Face 데이터셋을 다운로드합니다.
2. LeRobot 포맷 버전을 감지하고, v3이면 v2.1로 변환합니다(GR00T 파인튜닝이
   기대하는 포맷). 변환 로직은
   `e2e-workshop/groot/training/data/convert_v3_to_v2.py`를 함수 단위로 재현해
   인라인으로 내장했습니다.
3. 준비 시점에 `meta/modality.json`을 기록해 게시되는 데이터셋을 자체
   완결형으로 만듭니다(업스트림은 이걸 학습 시점에 기록).
4. 결과를 검증하고 OSMO 출력 데이터셋으로 게시합니다.

## e2e-workshop 매핑

`groot/training/data/{upload_dataset,convert_v3_to_v2}.py`를 적응한 것입니다.
업스트림 스크립트는 S3에 기록하지만, 여기서는 출력이 OSMO 데이터셋으로 가고
변환이 pod 안에서 인라인으로 실행됩니다.
