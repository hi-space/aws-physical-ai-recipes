"""Activate the managed external verifier without touching a VM or user apps."""
import json
import subprocess
import time


def require_idle_console(rows, session_id, user):
    if (len(rows) != 1 or rows[0].get("id") != session_id
            or rows[0].get("type") != "console" or rows[0].get("owner") != user
            or rows[0].get("num-of-connections") != 0):
        raise RuntimeError("Initial DCV authentication activation requires only the registered idle console; no virtual sessions or connected clients")


def activate_idle_console(session_id, user, run=subprocess.run):
    def sessions():
        return json.loads(run(["dcv", "list-sessions", "--json"], check=True,
                              capture_output=True, text=True, timeout=10).stdout)

    # Recheck immediately before the only service mutation.
    require_idle_console(sessions(), session_id, user)
    run(["systemctl", "restart", "dcvserver"], check=True, capture_output=True, timeout=40)
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        try:
            rows = sessions()
        except subprocess.CalledProcessError:
            time.sleep(1)
            continue
        if rows:
            if (len(rows) != 1 or rows[0].get("id") != session_id
                    or rows[0].get("type") != "console" or rows[0].get("owner") != user):
                raise RuntimeError("Registered DCV console identity was not restored")
            if rows[0].get("status") == "running":
                return
        else:
            # server-ready reports capacity to CREATE a console, not the health
            # of an existing console (which can legitimately make it return 1).
            result = run(["dcv", "server-ready", "--type=console"],
                         capture_output=True, timeout=5)
            if result.returncode == 0:
                run(["dcv", "create-session", session_id, "--owner", user, "--type", "console"],
                    check=True, capture_output=True, timeout=15)
                continue
        time.sleep(1)
    raise RuntimeError("DCV console service did not become ready after activation")
