# Isaac Sim Livestream

Interactive NVIDIA Isaac Sim session with livestreaming enabled. The workflow launches Isaac Sim in headless mode on a G7e GPU node and exposes the rendering stream via OSMO port-forward.

Two workflow files are provided:

| File | Isaac Sim | Memory | Notes |
| --- | --- | --- | --- |
| `workflow.yaml` | 4.5.0 (stable) | 16Gi | e2e-workshop stable 프로필과 동일 |
| `workflow-5.1.yaml` | 5.1.0 (latest) | 32Gi | 더 큰 메모리 할당 (5.1 기본 요구량 증가) |

Isaac Sim 5.0.0은 별도 워크플로우를 두지 않습니다. 5.0은 5.1로 빠르게 대체된
과도기 릴리스라, e2e-workshop과 동일하게 stable(4.5)/latest(5.1) 두 프로필만
유지합니다. 5.0에서 실행해야 한다면 `isaac_sim_image`를
`nvcr.io/nvidia/isaac-sim:5.0.0`으로 오버라이드하면 되지만(포트/`runheadless.sh`
경로는 5.1과 동일), 검증 대상은 아닙니다.

```bash
GPU_PREWARM_INSTANCE_TYPE=g7e.2xlarge scripts/prewarm-gpu-node.sh

# stable (Isaac Sim 4.5.0)
osmo workflow submit examples/isaacsim-livestream/workflow.yaml

# latest (Isaac Sim 5.1.0)
osmo workflow submit examples/isaacsim-livestream/workflow-5.1.yaml
```

Once the task reaches `Running` state, open two terminals for TCP and UDP port-forwarding:

```bash
osmo workflow port-forward <workflow-id> stream \
  --port 47995-48012,49000-49007,49100 \
  --connect-timeout 300

osmo workflow port-forward <workflow-id> stream \
  --port 47995-48012,49000-49007 \
  --udp \
  --connect-timeout 300
```

Then open the Isaac Sim Streaming Client on your local machine and connect to `localhost`.

Cleanup:

```bash
scripts/wait-gpu-node-cleanup.sh
```

Notes:

- The workflow has a 2h execution timeout. The sim stays alive until timeout or manual cancellation (`osmo workflow cancel <workflow-id>`).
- Port ranges: `47995-48012` (app streaming), `49000-49007` (video), `49100` (control).
- Isaac Sim 4.5.0 requires ~12GB GPU memory at idle; 5.1.0 requires ~18GB. Scenes with large assets may need a larger instance type.
