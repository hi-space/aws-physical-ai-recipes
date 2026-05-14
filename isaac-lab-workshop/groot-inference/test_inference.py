import zmq, msgpack, numpy as np, io

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

# ZMQ 연결
ctx = zmq.Context()
sock = ctx.socket(zmq.REQ)
sock.connect("tcp://localhost:5555")

# 관측 데이터 구성 (더미 데이터)
observation = {
    "video": {
        # 카메라 영상: (batch=1, temporal=1, H=256, W=256, RGB=3)
        "ego_view_bg_crop_pad_res256_freq20": np.random.randint(0, 255, (1, 1, 256, 256, 3), dtype=np.uint8)
    },
    "state": {
        # 각 관절의 현재 위치 (batch=1, temporal=1, joints)
        "left_arm": np.random.rand(1, 1, 7).astype(np.float32),
        "right_arm": np.random.rand(1, 1, 7).astype(np.float32),
        "left_hand": np.random.rand(1, 1, 6).astype(np.float32),
        "right_hand": np.random.rand(1, 1, 6).astype(np.float32),
        "waist": np.random.rand(1, 1, 3).astype(np.float32),
    },
    "language": {
        # 자연어 태스크 명령
        "task": [["pick up the cup"]]
    }
}

# 추론 요청
request = {"endpoint": "get_action", "data": {"observation": observation}}
sock.send(msgpack.packb(request, default=encode_ndarray))
response = msgpack.unpackb(sock.recv(), raw=False, object_hook=decode_ndarray)

# 결과 확인
if isinstance(response, list):
    action = response[0]
    print("추론 성공! Action keys:", list(action.keys()))
    for key in action:
        print(f"  {key}: shape={np.array(action[key]).shape}")
elif isinstance(response, dict) and "error" in response:
    print("에러:", response["error"])
else:
    print("예상치 못한 응답:", type(response))
