"""Verify ROS 2 payload transfer, not only DDS discovery."""
import argparse
import json
import os
from pathlib import Path
import socket
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--role", choices=["publisher", "subscriber"], required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--messages", type=int, default=20)
    parser.add_argument("--timeout", type=int, default=120)
    args = parser.parse_args()
    if args.messages < 1 or args.timeout < 1:
        parser.error("messages and timeout must be positive")
    if os.environ.get("ROS_DISCOVERY_SERVER"):
        host, port = os.environ["ROS_DISCOVERY_SERVER"].rsplit(":", 1)
        os.environ["ROS_DISCOVERY_SERVER"] = f"{socket.gethostbyname(host)}:{port}"
    import rclpy
    from std_msgs.msg import String
    rclpy.init()
    node = rclpy.create_node("recipe_" + args.role)
    topic = "/physical_ai/run_" + args.run_id.replace("-", "_")
    records = []
    started = time.monotonic()
    if args.role == "publisher":
        publisher = node.create_publisher(String, topic, 10)

        def publish():
            message = String()
            message.data = json.dumps({"runId": args.run_id, "sequence": len(records), "payload": "physical-ai-ros2"})
            publisher.publish(message)
            records.append(message.data)
        node.create_timer(0.1, publish)
    else:
        def receive(message):
            payload = json.loads(message.data)
            if payload.get("runId") == args.run_id and payload.get("payload") == "physical-ai-ros2":
                if payload["sequence"] not in {r["sequence"] for r in records}:
                    records.append(payload)
        node.create_subscription(String, topic, receive, 10)
    try:
        while time.monotonic() - started < args.timeout:
            rclpy.spin_once(node, timeout_sec=0.1)
            if args.role == "subscriber" and len(records) >= args.messages:
                output = Path(args.output_dir)
                output.mkdir(parents=True, exist_ok=True)
                (output / "ros2-transfer.json").write_text(json.dumps({
                    "type": "communication", "runId": args.run_id, "topic": topic,
                    "messageCount": len(records), "messages": records,
                }, indent=2))
                return
        raise TimeoutError(f"ROS2 {args.role}: insufficient verified messages before timeout")
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == "__main__":
    main()
