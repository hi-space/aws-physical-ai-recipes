"""Actual cross-container DDS payload test; no AWS or external network access."""
import json
from pathlib import Path
import subprocess
import unittest
import uuid


class RosTransfer(unittest.TestCase):
    def test_discovery_publisher_and_subscriber_exchange_run_scoped_payloads(self):
        name = "recipe-" + uuid.uuid4().hex[:10]
        image = "physical-ai-ros2:recipe-test"
        children = []

        def docker(*args, **kwargs):
            result = subprocess.run(["docker", *args], capture_output=True, text=True, **kwargs)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            return result.stdout.strip()

        docker("network", "create", "--internal", name)
        try:
            for role, command in [
                ("discovery", "exec fastdds discovery --server-id 0 -p 11811"),
                ("publisher", f"exec python3 /opt/recipes/ros2/transfer.py --role publisher --output-dir /tmp/out --run-id {name} --timeout 45"),
            ]:
                container = name + "-" + role
                docker("run", "--detach", "--name", container, "--network", name, "--network-alias", role,
                       "-e", "ROS_DISCOVERY_SERVER=discovery:11811", image, "bash", "-ec",
                       "source /opt/ros/humble/setup.bash\n" + command)
                children.append(container)
            result = docker("run", "--rm", "--network", name, "-e", "ROS_DISCOVERY_SERVER=discovery:11811",
                            image, "bash", "-ec",
                            "source /opt/ros/humble/setup.bash\n"
                            f"python3 /opt/recipes/ros2/transfer.py --role subscriber --output-dir /tmp/out --run-id {name} --messages 10 --timeout 30\n"
                            "cat /tmp/out/ros2-transfer.json", timeout=40)
            report = json.loads(result)
            self.assertEqual(report["type"], "communication")
            self.assertEqual(report["messageCount"], 10)
            self.assertEqual(len({message["sequence"] for message in report["messages"]}), 10)
            self.assertTrue(all(message["runId"] == name for message in report["messages"]))
        finally:
            for child in children:
                subprocess.run(["docker", "rm", "--force", child], capture_output=True)
            subprocess.run(["docker", "network", "rm", name], capture_output=True)


if __name__ == "__main__":
    unittest.main()
