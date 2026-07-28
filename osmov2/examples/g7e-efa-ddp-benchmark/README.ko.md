# G7e EFA DDP Benchmark

> 이 문서는 [README.md](README.md)(영문)의 한국어 번역본입니다.

동일한 G7e 풀에서 EFA 기반 NCCL과 NCCL 소켓 네트워킹을 비교하는 Kubernetes 네이티브 2노드 PyTorch DDP 벤치마크.

이 벤치마크는 의도적으로 합성(synthetic)이고 통신 집약적입니다. 모델 품질이나 엔드투엔드 데이터셋 처리량이 아닌, 대규모 그래디언트 페이로드를 가진 DDP 모델의 학습 스텝 wall-clock 시간을 측정합니다. 그래디언트 동기화가 많은 작업에서 EFA가 멀티노드 학습 시간에 영향을 주는지 확인할 때 사용하십시오.

사전 요구 사항:

- `scripts/deploy-karpenter.sh`로 G7e NodePool이 배포되어 있어야 합니다.
- `scripts/deploy-efa-device-plugin.sh`로 AWS EFA 디바이스 플러그인이 배포되어 있어야 합니다.
- `infra/core`에서 EFA에 필요한 노드 보안 그룹 self ingress/egress 규칙이 적용되어 있어야 합니다.
- EFA 지원 G7e 노드를 최소 2개 프로비저닝할 수 있어야 합니다. EFA 모드는 `vpc.amazonaws.com/efa: 1`을 요청하며, 두 모드 모두 pod당 GPU 1개를 요청합니다.

실행:

```bash
KUBE_CONTEXT=aws-osmo-dev-repro-apne2 \
  examples/g7e-efa-ddp-benchmark/run.sh
```

실행기는 동일한 PyTorch 학습 스크립트로 두 가지 모드를 실행합니다:

- `efa`: `vpc.amazonaws.com/efa: 1`을 요청하여 NCCL이 AWS OFI NCCL/Libfabric 경로를 사용하게 합니다.
- `socket`: EFA를 요청하지 않으며 `NCCL_NET=Socket`을 설정하여 NCCL이 일반 pod 네트워크 경로를 사용하게 합니다.

기본 워크로드:

- 노드 2개
- 노드당 GPU 1개
- 랭크당 그래디언트 페이로드 256 MiB
- 워밍업 스텝 2회
- 측정 학습 스텝 12회

검증:

- [validation.md](validation.md)
- [validation/summary.json](validation/summary.json)
- [validation/summary.csv](validation/summary.csv)
- [validation/training-time.svg](validation/training-time.svg)
- [validation/efa-master.log](validation/efa-master.log)
- [validation/socket-master.log](validation/socket-master.log)
