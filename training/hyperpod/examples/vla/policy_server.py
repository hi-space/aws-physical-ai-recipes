"""GR00T Policy Server (ZMQ) for Isaac Sim closed-loop evaluation.

Loads a fine-tuned GR00T model and serves inference via ZMQ REQ/REP.
The Isaac Sim client (run_closed_loop.py) sends observations and receives
16-step action chunks.

Protocol (msgpack):
  Request:  {"endpoint": "get_action", "data": {"observation": {...}}}
  Response: [action_dict, info_dict]

  Request:  {"endpoint": "ping"}
  Response: {"status": "ok"}

Usage:
  source /fsx/envs/gr00t/bin/activate
  export HF_TOKEN=$(cat /fsx/scratch/.hf_token)
  python policy_server.py \
    --model-path /fsx/checkpoints/vla/groot-demo_data/checkpoint-10 \
    --embodiment-tag NEW_EMBODIMENT \
    --port 5555
"""

import argparse
import io
import sys
import time

import msgpack
import numpy as np
import zmq


def parse_args():
    parser = argparse.ArgumentParser(description="GR00T ZMQ Policy Server")
    parser.add_argument("--model-path", type=str, required=True,
                        help="Path to fine-tuned GR00T checkpoint")
    parser.add_argument("--embodiment-tag", type=str,
                        default="NEW_EMBODIMENT",
                        help="Embodiment tag for the model")
    parser.add_argument("--host", type=str, default="0.0.0.0")
    parser.add_argument("--port", type=int, default=5555)
    parser.add_argument("--device", type=str, default="cuda:0")
    parser.add_argument("--modality-config", type=str, default=None,
                        help="Custom modality config path (for NEW_EMBODIMENT)")
    return parser.parse_args()


def encode_default(obj):
    if isinstance(obj, np.ndarray):
        buf = io.BytesIO()
        np.save(buf, obj, allow_pickle=False)
        return {"__ndarray_class__": True, "as_npy": buf.getvalue()}
    return obj


def decode_hook(obj):
    if isinstance(obj, dict) and ("__ndarray_class__" in obj or b"__ndarray_class__" in obj):
        npy_data = obj.get("as_npy") or obj.get(b"as_npy")
        return np.load(io.BytesIO(npy_data), allow_pickle=False)
    if isinstance(obj, dict):
        return {(k.decode() if isinstance(k, bytes) else k): v for k, v in obj.items()}
    return obj


def main():
    args = parse_args()

    print(f"Loading GR00T model from {args.model_path}...")
    from gr00t.policy.gr00t_policy import Gr00tPolicy
    from gr00t.data.embodiment_tags import EmbodimentTag

    tag = EmbodimentTag.resolve(args.embodiment_tag)

    policy_kwargs = dict(
        embodiment_tag=tag,
        model_path=args.model_path,
        device=args.device,
    )
    if args.modality_config:
        policy_kwargs["modality_config_path"] = args.modality_config

    policy = Gr00tPolicy(**policy_kwargs)
    print(f"Model loaded. Embodiment: {tag}")
    print(f"Modalities: {list(policy.get_modality_config().keys())}")

    context = zmq.Context()
    socket = context.socket(zmq.REP)
    socket.bind(f"tcp://{args.host}:{args.port}")
    print(f"Policy server listening on tcp://{args.host}:{args.port}")

    request_count = 0
    while True:
        try:
            msg = socket.recv()
            request = msgpack.unpackb(msg, object_hook=decode_hook, raw=False)

            endpoint = request.get("endpoint", "")

            if endpoint == "ping":
                response = {"status": "ok"}
            elif endpoint == "get_modality_config":
                mc = policy.get_modality_config()
                response = {
                    "video_keys": mc["video"].modality_keys,
                    "state_keys": mc["state"].modality_keys,
                    "action_keys": mc["action"].modality_keys,
                    "language_keys": mc["language"].modality_keys,
                }
            elif endpoint == "get_action":
                obs = request["data"]["observation"]
                t0 = time.time()
                action_dict, info = policy.get_action(obs)
                elapsed = time.time() - t0
                request_count += 1
                if request_count % 10 == 1:
                    print(f"  [req {request_count}] get_action: {elapsed*1000:.1f}ms")
                response = [action_dict, info if info else {}]
            else:
                response = {"error": f"Unknown endpoint: {endpoint}"}

            packed = msgpack.packb(response, default=encode_default)
            socket.send(packed)

        except KeyboardInterrupt:
            print("\nShutting down policy server...")
            break
        except Exception as e:
            print(f"Error handling request: {e}")
            try:
                error_resp = msgpack.packb({"error": str(e)}, default=encode_default)
                socket.send(error_resp)
            except Exception:
                pass

    socket.close()
    context.term()


if __name__ == "__main__":
    main()
