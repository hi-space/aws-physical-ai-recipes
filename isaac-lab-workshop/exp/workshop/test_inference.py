"""GR00T Policy Server inference test script.

Tests that the Policy Server responds correctly to ping and get_action requests.
Run from DCV instance after starting the Policy Server container.

Usage:
  python3 test_inference.py [--host HOST] [--port PORT]
"""
import argparse
import io
import time

import msgpack
import numpy as np
import zmq


def encode_custom(obj):
    if isinstance(obj, np.ndarray):
        buf = io.BytesIO()
        np.save(buf, obj, allow_pickle=False)
        return {"__ndarray_class__": True, "as_npy": buf.getvalue()}
    return obj


def decode_custom(obj):
    if not isinstance(obj, dict):
        return obj
    if "__ndarray_class__" in obj:
        return np.load(io.BytesIO(obj["as_npy"]), allow_pickle=False)
    return obj


def to_bytes(data):
    return msgpack.packb(data, default=encode_custom)


def from_bytes(data):
    return msgpack.unpackb(data, object_hook=decode_custom)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="localhost")
    parser.add_argument("--port", type=int, default=5555)
    args = parser.parse_args()

    ctx = zmq.Context()
    sock = ctx.socket(zmq.REQ)
    sock.setsockopt(zmq.RCVTIMEO, 60000)
    sock.connect(f"tcp://{args.host}:{args.port}")

    # Ping
    sock.send(to_bytes({"endpoint": "ping"}))
    response = from_bytes(sock.recv())
    print(f"Ping: {response}")
    assert response.get("status") == "ok", "Ping failed!"

    # Inference with dummy observation (new_embodiment format)
    observation = {
        "video": {
            "front": np.random.randint(0, 255, (1, 1, 224, 224, 3), dtype=np.uint8),
            "wrist": np.random.randint(0, 255, (1, 1, 224, 224, 3), dtype=np.uint8),
        },
        "state": {
            "single_arm": np.zeros((1, 1, 5), dtype=np.float32),
            "gripper": np.array([[[30.0]]], dtype=np.float32),
        },
        "language": {
            "annotation.human.task_description": [["pick up the cube"]],
        },
    }

    print("\nSending inference request...")
    t0 = time.time()
    sock.send(to_bytes({"endpoint": "get_action", "data": {"observation": observation}}))
    response = from_bytes(sock.recv())
    elapsed = time.time() - t0

    action, info = response[0], response[1]
    print(f"Inference time: {elapsed:.2f}s")
    print(f"Action - single_arm: shape={action['single_arm'].shape}")
    print(f"Action - gripper:    shape={action['gripper'].shape}")

    assert action["single_arm"].shape == (1, 16, 5), f"Unexpected shape: {action['single_arm'].shape}"
    assert action["gripper"].shape == (1, 16, 1), f"Unexpected shape: {action['gripper'].shape}"

    print("\nSUCCESS: Policy Server is working correctly!")


if __name__ == "__main__":
    main()
