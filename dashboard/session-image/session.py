"""Fixed local-only development app launchers; no credentials, package installs, or shell interpolation."""
import os
import socket
import sys

PORTS = {"tensorboard": 6006, "jupyter": 8888, "code-server": 8080}
IDENTITY_ENV = {
    "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_ROLE_ARN",
    "AWS_WEB_IDENTITY_TOKEN_FILE", "AWS_CONTAINER_CREDENTIALS_FULL_URI",
    "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "AWS_CONTAINER_AUTHORIZATION_TOKEN",
    "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE", "PAI_RUNTIME_TOKEN",
}


def command(kind, prefix=""):
    if prefix and (not prefix.startswith("/s/") or prefix.endswith("/") or len(prefix) > 80):
        raise ValueError("Invalid session prefix")
    if kind == "tensorboard":
        return ["tensorboard", "--logdir=/logs", "--host=127.0.0.1", "--port=6006", "--reload_interval=15"] + \
            ([f"--path_prefix={prefix}"] if prefix else [])
    if kind == "jupyter":
        return ["jupyter", "lab", "--ServerApp.ip=127.0.0.1", "--ServerApp.port=8888",
                "--ServerApp.port_retries=0", "--ServerApp.open_browser=False",
                "--ServerApp.root_dir=/workspace", "--ServerApp.allow_remote_access=True",
                "--ServerApp.trust_xheaders=True", "--IdentityProvider.token=",
                "--PasswordIdentityProvider.hashed_password="] + \
            ([f"--ServerApp.base_url={prefix}/"] if prefix else [])
    if kind == "code-server":
        return ["code-server", "--bind-addr=127.0.0.1:8080", "--auth=none",
                "--disable-telemetry", "--disable-update-check", "/workspace"]
    raise ValueError("Unsupported workspace application")


def main(args):
    if len(args) == 2 and args[0] == "--ready" and args[1] in PORTS:
        with socket.create_connection(("127.0.0.1", PORTS[args[1]]), timeout=2):
            return 0
    if len(args) != 1 or args[0] not in PORTS:
        raise ValueError("Expected a registered workspace application")
    # A misconfigured IRSA/Pod Identity association must fail before opening an app.
    if any(os.environ.get(name) for name in IDENTITY_ENV):
        raise ValueError("Workspace identity injection is not permitted")
    env = {key: value for key, value in os.environ.items() if not key.startswith(("AWS_", "PAI_RUNTIME_"))}
    env["AWS_EC2_METADATA_DISABLED"] = "true"
    for relative in (".config", ".cache", ".local/share", ".jupyter"):
        os.makedirs(os.path.join("/workspace", relative), mode=0o700, exist_ok=True)
    prefix = os.environ.get("PAI_SESSION_PREFIX", "")
    argv = command(args[0], prefix)
    os.execvpe(argv[0], argv, env)


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except Exception:
        print("Workspace start/readiness check failed", file=sys.stderr)
        sys.exit(1)
