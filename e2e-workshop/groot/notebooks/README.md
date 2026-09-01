# GR00T Workshop Notebooks

워크숍의 VLA 트랙(인프라·베이스 모델 확인 → 파이프라인 학습 → closed-loop 평가)을 노트북으로 따라올 수 있도록 정리한 디렉토리입니다. 스크립트를 직접 CLI로 실행하는 대신, 셀 단위로 실행하며 중간 출력을 확인하고 싶을 때 사용합니다.

## Prerequisites

노트북을 열기 전에 1회 셋업 스크립트를 실행합니다. `uv` 환경 동기화, Jupyter 커널 등록(`GR00T (uv)`), code-server 확장 설치, `config.yaml` 채우기까지 한 번에 처리합니다.

```bash
cd e2e-workshop/groot
./setup-notebooks.sh <region>
```

## Notebooks

| 파일 | 워크숍 모듈 | 내용 |
| --- | --- | --- |
| [`01_infra_and_base_check.ipynb`](./01_infra_and_base_check.ipynb) | 모듈 3 | 인프라 배포 상태 + GR00T base 모델 검증 |
| [`02_sagemaker_pipeline.ipynb`](./02_sagemaker_pipeline.ipynb) | 모듈 4 | 5노드 SageMaker Pipeline(TransformDataset → GR00TFinetune → SmokeEval → SmokeGate → RegisterModel/FailStep) 조립·실행 (핵심 모듈). 데이터셋 업로드 준비는 별도 단계 없이 TransformDataset이 흡수 |
| [`03_closed_loop_eval.ipynb`](./03_closed_loop_eval.ipynb) | 모듈 5 | 시뮬레이션 closed-loop 평가 래퍼 |

## 실행법

1. code-server를 브라우저로 엽니다 (배포 출력의 CodeServer URL).
2. 이 디렉토리의 `.ipynb` 파일을 엽니다.
3. 커널로 `GR00T (uv)`를 선택합니다.

### Fallback

code-server에서 노트북 실행이 매끄럽지 않으면 Jupyter Lab을 직접 띄워 사용합니다.

```bash
cd e2e-workshop/groot
uv run --extra notebooks jupyter lab --no-browser --port 8889
```

DCV 데스크탑의 브라우저에서 `http://localhost:8889` 로 접속합니다.

