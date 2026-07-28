# G7e EFA NCCL Benchmark

> 이 문서는 [README.md](README.md)(영문)의 한국어 번역본입니다.

레퍼런스 G7e 풀에서 멀티노드 GPU 집합 통신(collective)에 AWS EFA를 사용할 수 있는지 검증하는 Kubernetes 네이티브 2노드 NCCL `all_reduce_perf` 벤치마크.

이것은 의도적으로 OSMO 워크플로우가 아닙니다. EFA 검증은 런처와 워커가 별도 노드에서 실행되어 `aws-ofi-nccl`을 통해 NCCL 트래픽을 교환할 때 의미가 있습니다. Kubernetes pod 형태는 EFA 리소스 요청, hugepages, `/dev/shm`, MPI 런치 경로를 명시적으로 유지합니다.

사전 요구 사항:

- `scripts/deploy-karpenter.sh`로 G7e NodePool이 배포되어 있어야 합니다.
- `scripts/deploy-efa-device-plugin.sh`로 AWS EFA 디바이스 플러그인이 배포되어 있어야 합니다.
- `infra/core`에서 EFA에 필요한 노드 보안 그룹 self ingress/egress 규칙이 적용되어 있어야 합니다.
- EFA 지원 G7e 노드를 최소 2개 프로비저닝할 수 있어야 합니다. 벤치마크는 `vpc.amazonaws.com/efa: 1`을 요청하므로 Karpenter가 제로에서 스케일 아웃할 수 있습니다.

실행:

```bash
KUBE_CONTEXT=aws-osmo-dev-repro-apne2 \
  examples/g7e-efa-nccl-benchmark/run.sh
```

실행기는 임시 SSH 키를 생성하고, 워커 pod와 런처 pod를 만들고, 런타임 컨테이너에 NCCL `2.28.9-1+cuda13.0`을 설치하고, Blackwell `sm_120`용으로 `nccl-tests`를 재빌드한 뒤, 2노드 `all_reduce_perf`를 실행합니다.

`all_reduce_perf`는 out-of-place 및 in-place 대역폭을 모두 보고합니다. out-of-place는 별도의 입력 및 출력 버퍼를 사용하고, in-place는 reduce 결과를 입력 버퍼에 다시 씁니다. 목적이 버퍼 레이아웃 비교가 아닌 멀티노드 NCCL 전송 경로 검증이므로 두 값이 유사하게 나올 것으로 예상됩니다. EFA 유무에 따른 학습 wall-clock 비교는 [g7e-efa-ddp-benchmark](../g7e-efa-ddp-benchmark/README.md)를 사용하십시오.

검증:

- [validation.md](validation.md)
- [validation/nccl-efa-2node.log](validation/nccl-efa-2node.log)
- [validation/nccl-efa-2node-bandwidth.csv](validation/nccl-efa-2node-bandwidth.csv)
- [validation/nccl-efa-2node-bandwidth.svg](validation/nccl-efa-2node-bandwidth.svg)
