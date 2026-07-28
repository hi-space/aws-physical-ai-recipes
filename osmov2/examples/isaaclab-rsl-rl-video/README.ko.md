# Isaac Lab RSL-RL Video

> 이 문서는 [README.md](README.md)(영문)의 한국어 번역본입니다.

`Isaac-Reach-Franka-v0`를 위한 Isaac Lab RSL-RL 워크플로우. 제한된 반복 횟수만큼 학습한 뒤 checkpoint, 스칼라 요약, 학습 전후 비디오를 내보냅니다.

| 파일 | Isaac Lab / Sim | 플랫폼 | 비고 |
| --- | --- | --- | --- |
| `workflow.yaml` | 2.2.0 (Isaac Sim 4.5.0) | G7e | stable, 검증 완료 |
| `workflow-g6.yaml` | 2.2.0 (Isaac Sim 4.5.0) | G6 L4 | G6 fallback |
| `workflow-g6-video.yaml` | 2.2.0 (Isaac Sim 4.5.0) | G6 L4 | 비디오 전용 변형 |
| `workflow-5.1.yaml` | 2.3.0 (Isaac Sim 5.1.0) | G7e | latest |

저장소 래퍼를 통해 실행:

```bash
GPU_PREWARM_INSTANCE_TYPE=g7e.2xlarge scripts/prewarm-gpu-node.sh
SMOKE_SET_NGC_CREDENTIAL=true \
  WORKFLOW_FILE=examples/isaaclab-rsl-rl-video/workflow.yaml \
  SMOKE_TIMEOUT_ATTEMPTS=720 \
  scripts/smoke-test.sh
scripts/wait-gpu-node-cleanup.sh
```

검증:

- [validation.md](validation.md)
- 새 실행: `aws-isaaclab-rsl-rl-video-9`
- 관측된 런타임: G7e 프리웜 후 `976s`
- 예상 완료 시간: G7e 프로비저닝 및 정리 포함 `30-35 min`
- 아티팩트 데이터셋: `aws-osmo/aws-isaaclab-rsl-rl-video-artifacts:4`
- 아티팩트: `before-training.mp4`, `after-training.mp4`, TensorBoard 스칼라 CSV, `metrics-summary.json`, `model_199.pt`

결과:

- [학습 전후 미리보기](validation/result/videos/before-after-preview.png)
- [학습 전후 비교](validation/result/videos/before-after-comparison.mp4)
- [학습 전 비디오](validation/result/videos/before-training.mp4)
- [학습 후 비디오](validation/result/videos/after-training.mp4)
- [메트릭 요약](validation/result/metrics-summary.json)

`Isaac-Reach-Franka-v0`는 고정된 Isaac Lab 이미지에 포함되어 있고 빠르게 가시적인 아티팩트를 생성하기 때문에 이 예제에서 사용합니다.
