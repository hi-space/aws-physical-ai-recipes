import sys
import zmq, msgpack, numpy as np, io

if len(sys.argv) < 2:
    print("Usage: uv run python test_inference_remote.py <INSTANCE_IP>")
    sys.exit(1)

SERVER_IP = sys.argv[1]

def encode_ndarray(obj):
    if isinstance(obj, np.ndarray):
        buf = io.BytesIO()
        np.save(buf, obj, allow_pickle=False)
        return {"__ndarray_class__": True, "as_npy": buf.getvalue()}
    return obj

def decode_ndarray(obj):
    if isinstance(obj, dict) and "__ndarray_class__" in obj:
        return np.load(io.BytesIO(obj["as_npy"]), allow_pickle=False)
    return obj

# ZMQ 연결 (원격 서버)
ctx = zmq.Context()
sock = ctx.socket(zmq.REQ)
sock.setsockopt(zmq.RCVTIMEO, 10000)  # 10초 타임아웃
sock.connect(f"tcp://{SERVER_IP}:5555")

# Ping 테스트
sock.send(msgpack.packb({"endpoint": "ping"}))
print("Ping:", msgpack.unpackb(sock.recv(), raw=False))

# 추론 테스트 (더미 데이터)
observation = {
    "video": {
        "ego_view_bg_crop_pad_res256_freq20": np.random.randint(0, 255, (1, 1, 256, 256, 3), dtype=np.uint8)
    },
    "state": {
        "left_arm": np.random.rand(1, 1, 7).astype(np.float32),
        "right_arm": np.random.rand(1, 1, 7).astype(np.float32),
        "left_hand": np.random.rand(1, 1, 6).astype(np.float32),
        "right_hand": np.random.rand(1, 1, 6).astype(np.float32),
        "waist": np.random.rand(1, 1, 3).astype(np.float32),
    },
    "language": {"task": [["pick up the cup"]]}
}

request = {"endpoint": "get_action", "data": {"observation": observation}}
sock.send(msgpack.packb(request, default=encode_ndarray))
response = msgpack.unpackb(sock.recv(), raw=False, object_hook=decode_ndarray)

if isinstance(response, list):
    action = response[0]
    print("추론 성공! Action keys:", list(action.keys()))
    for key in action:
        print(f"  {key}: shape={np.array(action[key]).shape}")
elif isinstance(response, dict) and "error" in response:
    print("에러:", response["error"])
else:
    print("예상치 못한 응답:", type(response))
