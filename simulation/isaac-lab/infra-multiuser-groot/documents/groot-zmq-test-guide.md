# GR00T ZMQ Inference Server Test Guide

How to verify the GR00T inference server is working after CDK deployment.

## Prerequisites

- CDK deployment complete (with `grootRepoUrl` set)
- `groot-docker-build.service` complete (20-30 min after reboot)
- `groot-inference.service` running

```bash
systemctl is-active groot-inference.service   # must be "active"
ss -tlnp | grep 5555                          # port must be listening
docker ps | grep groot                        # container must be running
```

## Install GR00T Client Library

```bash
cd /home/ubuntu/environment/groot_docker/gr00t
pip3 install msgpack pyzmq numpy
```

## GR1 Embodiment Modality Config

Retrieved from `processor_config.json`:

| Modality | Keys | Shape (B, T, D) |
|----------|------|-----------------|
| video | `ego_view_bg_crop_pad_res256_freq20` | (1, 1, 256, 256, 3) uint8 |
| state | `left_arm` | (1, 1, 7) float32 |
| state | `right_arm` | (1, 1, 7) float32 |
| state | `left_hand` | (1, 1, 6) float32 |
| state | `right_hand` | (1, 1, 6) float32 |
| state | `waist` | (1, 1, 3) float32 |
| language | `task` | [["text"]] (nested list) |
| action (output) | same 5 state keys | (1, 16, D) — 16 step horizon |

## Test 1: Server Connection (Ping)

```bash
cd /home/ubuntu/environment/groot_docker/gr00t

PYTHONPATH=$(pwd) python3 -c "
from gr00t.policy.server_client import PolicyClient
policy = PolicyClient(host='localhost', port=5555)
print('SUCCESS' if policy.ping() else 'FAILED')
"
```

## Test 2: Inference Request

```bash
cat > /tmp/test_groot.py << 'PYEOF'
import numpy as np
import time
from gr00t.policy.server_client import PolicyClient

policy = PolicyClient(host="localhost", port=5555)
obs = {
    "video": {"ego_view_bg_crop_pad_res256_freq20": np.random.randint(0, 255, (1, 1, 256, 256, 3), dtype=np.uint8)},
    "state": {
        "left_arm": np.random.rand(1, 1, 7).astype(np.float32),
        "right_arm": np.random.rand(1, 1, 7).astype(np.float32),
        "left_hand": np.random.rand(1, 1, 6).astype(np.float32),
        "right_hand": np.random.rand(1, 1, 6).astype(np.float32),
        "waist": np.random.rand(1, 1, 3).astype(np.float32),
    },
    "language": {"task": [["pick up the apple"]]},
}
start = time.time()
try:
    action, info = policy.get_action(obs)
    print(f"SUCCESS ({time.time()-start:.2f}s)")
    if isinstance(action, dict):
        for k, v in action.items():
            print(f"  {k}: shape={v.shape if hasattr(v,'shape') else type(v)}")
    elif isinstance(action, np.ndarray):
        print(f"  Action shape: {action.shape}")
except Exception as e:
    print(f"ERROR: {e}")
PYEOF
PYTHONPATH=/home/ubuntu/environment/groot_docker/gr00t python3 /tmp/test_groot.py
```

Expected output:
```
SUCCESS (0.33s)
  left_arm: shape=(1, 16, 7)
  right_arm: shape=(1, 16, 7)
  left_hand: shape=(1, 16, 6)
  right_hand: shape=(1, 16, 6)
  waist: shape=(1, 16, 3)
```

The 16-step action horizon means the model predicts 16 future timesteps of robot joint commands.

## Test 3: Performance Measurement

```bash
cat > /tmp/test_perf.py << 'PYEOF'
import numpy as np
import time
from gr00t.policy.server_client import PolicyClient

policy = PolicyClient(host="localhost", port=5555)
NUM_REQUESTS = 10

obs = {
    "video": {"ego_view_bg_crop_pad_res256_freq20": np.random.randint(0, 255, (1, 1, 256, 256, 3), dtype=np.uint8)},
    "state": {
        "left_arm": np.random.rand(1, 1, 7).astype(np.float32),
        "right_arm": np.random.rand(1, 1, 7).astype(np.float32),
        "left_hand": np.random.rand(1, 1, 6).astype(np.float32),
        "right_hand": np.random.rand(1, 1, 6).astype(np.float32),
        "waist": np.random.rand(1, 1, 3).astype(np.float32),
    },
    "language": {"task": [["pick up the apple"]]},
}

print("Warming up...")
policy.get_action(obs)

print(f"Measuring {NUM_REQUESTS} requests...")
latencies = []
for i in range(NUM_REQUESTS):
    start = time.time()
    policy.get_action(obs)
    latencies.append(time.time() - start)

avg = np.mean(latencies) * 1000
p50 = np.percentile(latencies, 50) * 1000
p99 = np.percentile(latencies, 99) * 1000
hz = 1.0 / np.mean(latencies)

print(f"SUCCESS: Performance measurement complete")
print(f"  Avg: {avg:.1f}ms | P50: {p50:.1f}ms | P99: {p99:.1f}ms")
print(f"  Throughput: {hz:.1f} Hz")
PYEOF
PYTHONPATH=/home/ubuntu/environment/groot_docker/gr00t python3 /tmp/test_perf.py
```

## Test 4: Remote Test from External PC

```bash
pip3 install pyzmq msgpack

python3 -c "
import zmq, msgpack

ctx = zmq.Context()
sock = ctx.socket(zmq.REQ)
sock.setsockopt(zmq.RCVTIMEO, 10000)
sock.connect('tcp://<PUBLIC_IP>:5555')

try:
    sock.send(msgpack.packb({'action': 'ping'}))
    resp = msgpack.unpackb(sock.recv(), raw=False)
    print('SUCCESS:', resp)
except zmq.error.Again:
    print('FAILED: Connection timeout')
finally:
    sock.close()
    ctx.term()
"
```

Expected output:
```
SUCCESS: {'error': "BasePolicy.get_action() missing 1 required positional argument: 'observation'"}
```

> The error message confirms the server is alive and processing requests.

**Important:** Do NOT use `recv_json()` — the GR00T server uses msgpack binary protocol. Using `recv_json()` will cause `UnicodeDecodeError`.

## Test Result Criteria

| Test | Success Criteria |
|------|-----------------|
| Test 1 (Ping) | `PolicyClient.ping()` returns True |
| Test 2 (Inference) | 5 action keys returned with shape (1, 16, D) |
| Test 3 (Performance) | Avg < 500ms, > 2 Hz |
| Test 4 (Remote) | Response received via msgpack |

## Troubleshooting

| Symptom | Check | Fix |
|---------|-------|-----|
| Connection refused | `ss -tlnp \| grep 5555` | Server not running: `systemctl status groot-inference.service` |
| `ModuleNotFoundError: gr00t` | PYTHONPATH not set | Use `PYTHONPATH=/home/ubuntu/environment/groot_docker/gr00t` |
| `ModuleNotFoundError: msgpack` | Package missing | `pip3 install msgpack pyzmq numpy` |
| `UnicodeDecodeError` on recv | Using `recv_json()` | Use `msgpack.unpackb(sock.recv())` instead |
| `Observation must contain 'video'` | Wrong obs key format | Use exact keys from modality config above |
| `must be shape (B, T, ...)` | Missing time dimension | All tensors need (Batch, Time, ...) shape |
| `Language key must be a list` | Using numpy array | Use nested list `[["text"]]` not `np.array` |
| Timeout | `nvidia-smi` | GPU OOM: kill other processes |
| Remote connection failed | AWS Console > SG rules | Verify TCP 5555 is open |

## How to Check Modality Config for Other Embodiments

```bash
docker exec groot-inference python3 -c "
import json
with open('/workspace/weights/GR00T-N1.6-3B/processor_config.json') as f:
    cfg = json.load(f)
for emb in cfg['processor_kwargs']['modality_configs']:
    print(emb)
"
```

To get details for a specific embodiment:

```bash
docker exec groot-inference python3 -c "
import json
with open('/workspace/weights/GR00T-N1.6-3B/processor_config.json') as f:
    cfg = json.load(f)
emb = cfg['processor_kwargs']['modality_configs']['gr1']
for mod, mc in emb.items():
    print(f'{mod}: keys={mc.get(\"modality_keys\",[])} delta={mc.get(\"delta_indices\",[])}')
"
```
