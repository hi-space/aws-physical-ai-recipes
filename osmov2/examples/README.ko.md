# Examples

> 이 문서는 [README.md](README.md)(영문)의 한국어 번역본입니다.

각 디렉터리는 독립적인 OSMO 또는 AWS 플랫폼 예제입니다.
단일 워크플로우 OSMO 예제는 `workflow.yaml`을 사용하며, 멀티스테이지 예제는
`workflows/` 하위에 번호가 붙은 워크플로우 YAML을 순서대로 보관합니다.
예제별 실행 메모와 검증 산출물은 예제 디렉터리 옆에 위치합니다.

| 예제 | 목적 | 검증 |
| --- | --- | --- |
| [osmo-smoke](osmo-smoke/README.md) | CPU 전용 OSMO 스모크 워크플로우. | [validation.md](osmo-smoke/validation.md)에서 확인. |
| [gpu-smoke](gpu-smoke/README.md) | `nvidia-smi`를 실행하는 OSMO GPU 스모크 워크플로우. | [validation.md](gpu-smoke/validation.md)에서 확인. |
| [g7e-efa-nccl-benchmark](g7e-efa-nccl-benchmark/README.md) | Kubernetes 네이티브 2-노드 G7e EFA NCCL all-reduce 벤치마크. | [validation.md](g7e-efa-nccl-benchmark/validation.md)에서 확인. |
| [g7e-efa-ddp-benchmark](g7e-efa-ddp-benchmark/README.md) | Kubernetes 네이티브 2-노드 G7e PyTorch DDP 학습 벤치마크로, EFA와 NCCL 소켓 네트워킹을 비교. | [validation.md](g7e-efa-ddp-benchmark/validation.md)에서 확인. |
| [parallel-eval](parallel-eval/README.md) | OSMO `groups` 팬아웃/팬인 레퍼런스. | [validation.md](parallel-eval/validation.md)에서 확인. |
| [sequential-policy](sequential-policy/README.md) | CPU 데이터셋 검사, GPU 정책 체크포인트 태스크, CPU 패키징 단계. | [validation.md](sequential-policy/validation.md)에서 확인. |
| [isaacsim-livestream](isaacsim-livestream/README.md) | OSMO port-forward를 통한 라이브스트리밍이 포함된 대화형 Isaac Sim 세션. | 연결 절차는 README 참고. |
| [isaaclab-rsl-rl-video](isaaclab-rsl-rl-video/README.md) | 비디오와 TensorBoard 플롯이 포함된 Isaac Lab RSL-RL 학습. | [validation.md](isaaclab-rsl-rl-video/validation.md)에서 확인. |
| [gr00t-finetune](gr00t-finetune/README.md) | PASK 정렬 GR00T 파인튜닝 워크플로우. | [validation.md](gr00t-finetune/validation.md)에서 E2E 및 10k 스텝 검증 확인. |
| [openpi-libero-lora](openpi-libero-lora/README.md) | PASK 정렬 OpenPI LIBERO LoRA 워크플로우. | [validation.md](openpi-libero-lora/validation.md)에서 E2E 및 30k 스텝 검증 확인. |
| [cosmos-reason2-nim](cosmos-reason2-nim/README.md) | Cosmos Reason2 NIM과 NVIDIA OSMO의 NIM 클라이언트/서버 패턴을 사용하는 세계 모델 VLM 워크플로우. | [validation.md](cosmos-reason2-nim/validation.md)에서 확인. |
| [hyworld2-worldmirror-recon](hyworld2-worldmirror-recon/README.md) | 업스트림 Dining Table 샘플에서 HY-World 2.0 WorldMirror를 사용하는 세계 모델 재구성 워크플로우. | [validation.md](hyworld2-worldmirror-recon/validation.md)에서 확인. |
| [lyra2-dmd-single](lyra2-dmd-single/README.md) | Lyra-2.0 DMD와 Gaussian-scene 트라젝터리 렌더링을 사용하는 세계 모델 생성 워크플로우. | [validation.md](lyra2-dmd-single/validation.md)에서 확인. |
| [closed-loop-sim-eval](closed-loop-sim-eval/README.md) | Isaac Sim에서 GR00T 정책 closed-loop 평가 (ZMQ 서버 + rollout). | 출력 형식은 README 참고. |
| [nut-pouring-pipeline](nut-pouring-pipeline/README.md) | MimicGen, Cosmos Transfer, LeRobot 변환, GR00T 파인튜닝을 포함하는 멀티스테이지 업스트림 OSMO 너트 붓기 파이프라인. | [validation.md](nut-pouring-pipeline/validation.md)에서 확인. |

단일 워크플로우 예제는 `osmo workflow submit examples/<name>/workflow.yaml`로 직접
제출하거나, OSMO 로그인, 자격증명, 제출, 로그, 타임아웃 처리를 레포 래퍼가 담당하게
하려면 `scripts/smoke-test.sh`를 사용하세요. 멀티스테이지 예제는 예제 README를
따르거나 번호가 붙은 워크플로우 파일을 순서대로 제출하세요.

GPU 워크플로우는 OSMO 리소스 검증 전에 G7e 용량이 관측 가능해야 합니다.
제출 전 `scripts/prewarm-gpu-node.sh`를, 완료 후 `scripts/wait-gpu-node-cleanup.sh`를
사용하세요.
