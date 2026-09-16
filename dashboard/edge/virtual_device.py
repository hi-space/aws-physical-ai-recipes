"""Communication-only virtual device. No actuator, robot, MQTT-control or AWS APIs."""
import argparse
import json
import secrets
import socket
import socketserver
import statistics
import threading
import time


class LeaseFence:
    """A receiver must enforce the latest lease epoch, not merely possess a token."""
    def __init__(self):
        self.lock = threading.Lock()
        self.lease = None

    def install(self, device_id, run_id, epoch, token, expires_at):
        with self.lock:
            if self.lease and epoch <= self.lease["epoch"]:
                raise ValueError("fencing epoch must increase")
            self.lease = dict(deviceId=device_id, runId=run_id, epoch=epoch, token=token, expiresAt=expires_at)

    def echo(self, message):
        with self.lock:
            lease = self.lease
            if set(message) != {"op", "deviceId", "runId", "epoch", "token", "sequence", "payload"} or message["op"] != "echo":
                raise ValueError("communication-only: motion/control/unknown operations are rejected")
            if not lease or lease["expiresAt"] <= time.time() * 1000:
                raise ValueError("expired lease")
            if any(message[k] != lease[k] for k in ("deviceId", "runId", "epoch")) or not secrets.compare_digest(message["token"], lease["token"]):
                raise ValueError("stale or foreign lease")
            if not isinstance(message["sequence"], int) or not isinstance(message["payload"], str) or len(message["payload"]) > 1024:
                raise ValueError("invalid echo payload")
            return {"type": "communication", "sequence": message["sequence"], "payload": message["payload"], "epoch": lease["epoch"]}


class EchoServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def run_probe(messages=10, lease=None):
    fence = LeaseFence()
    lease = lease or {"deviceId": "isolated-virtual", "runId": "local-test-run", "epoch": 1,
                      "token": secrets.token_hex(32), "expiresAt": time.time() * 1000 + 30_000}
    if lease.get("state", "ACTIVE") != "ACTIVE" or lease["expiresAt"] <= time.time() * 1000:
        raise ValueError("the supplied lease is not active")
    fence.install(lease["deviceId"], lease["runId"], lease["epoch"], lease["token"], lease["expiresAt"])

    class Handler(socketserver.StreamRequestHandler):
        def handle(self):
            self.request.settimeout(5)
            try:
                line = self.rfile.readline(4097)
                if len(line) > 4096:
                    raise ValueError("message too large")
                response = fence.echo(json.loads(line))
            except Exception as error:
                response = {"error": str(error)}
            self.wfile.write((json.dumps(response) + "\n").encode())

    with EchoServer(("127.0.0.1", 0), Handler) as server:
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        latencies = []
        for sequence in range(messages):
            payload = {"op": "echo", "deviceId": lease["deviceId"], "runId": lease["runId"], "epoch": lease["epoch"],
                       "token": lease["token"], "sequence": sequence, "payload": f"communication-{sequence}"}
            started = time.perf_counter()
            with socket.create_connection(server.server_address, timeout=5) as connection:
                connection.sendall((json.dumps(payload) + "\n").encode())
                response = json.loads(connection.makefile("rb").readline(4097))
            latencies.append((time.perf_counter() - started) * 1000)
            if response.get("payload") != payload["payload"] or response.get("sequence") != sequence:
                raise RuntimeError("echo payload did not match")
        server.shutdown()
        worker.join(timeout=5)
    values = sorted(latencies)
    def quantile(q):
        pos = q * (len(values) - 1)
        lo = int(pos)
        return values[lo] + (values[min(lo + 1, len(values) - 1)] - values[lo]) * (pos - lo)
    average = statistics.mean(values)
    return {"type": "communication", "messageCount": messages, "physicalHardwareTested": False,
            "deviceId": lease["deviceId"], "runId": lease["runId"], "leaseEpoch": lease["epoch"],
            "results": [{"mode": "virtual-communication", "avg_ms": average, "p50_ms": quantile(.5),
                         "p95_ms": quantile(.95), "p99_ms": quantile(.99), "std_ms": statistics.pstdev(values),
                         "hz": 1000 / average, "iterations": messages}]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-test", action="store_true", required=True)
    parser.add_argument("--messages", type=int, default=10)
    parser.add_argument("--lease-file", help="trusted current lease proof copied from the owner API; never a motion capability")
    args = parser.parse_args()
    if not 1 <= args.messages <= 10000:
        parser.error("messages must be 1–10000")
    if args.lease_file:
        from pathlib import Path
        lease = json.loads(Path(args.lease_file).read_text())
    else:
        lease = None
    print(json.dumps(run_probe(args.messages, lease), indent=2, allow_nan=False))
