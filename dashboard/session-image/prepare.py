"""Trusted initializer. Walk with dir-fds/O_NOFOLLOW; user containers never see the full PVC."""
import os
import re
import stat
import sys

LABEL = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\Z")
COMPONENT = re.compile(r"[A-Za-z0-9_.-]+\Z")
FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


def walk(root_fd, parts, create=False):
    current = os.dup(root_fd)
    try:
        for part in parts:
            if part in ("", ".", "..") or not COMPONENT.fullmatch(part):
                raise ValueError("Invalid storage component")
            if create:
                try:
                    os.mkdir(part, mode=0o755, dir_fd=current)
                except FileExistsError:
                    pass
            child = os.open(part, FLAGS, dir_fd=current)
            os.close(current)
            current = child
            if create:
                info = os.fstat(current)
                if info.st_uid != 0 or stat.S_IMODE(info.st_mode) & 0o022:
                    raise ValueError("Storage ancestor is not trusted")
        return current
    except BaseException:
        os.close(current)
        raise


def prepare(root, project, session, logs=None):
    if not LABEL.fullmatch(project) or not LABEL.fullmatch(session):
        raise ValueError("Invalid storage identity")
    root_fd = os.open(root, FLAGS)
    try:
        if logs:
            parts = logs.split("/")
            if len(parts) < 4 or parts[0] not in ("checkpoints", "datasets") or parts[1:3] != ["projects", project]:
                raise ValueError("Logs are outside this project")
            log_fd = walk(root_fd, parts)
            os.close(log_fd)
        parent = walk(root_fd, ["sessions", "projects", project], create=True)
        try:
            # A unique persisted session owns this leaf. On init retry, only this exact
            # root-owned parent and non-symlink leaf can be reused; never recurse/chown content.
            try:
                os.mkdir(session, mode=0o700, dir_fd=parent)
            except FileExistsError:
                pass
            leaf = os.open(session, FLAGS, dir_fd=parent)
            try:
                if os.fstat(leaf).st_uid not in (0, 1000):
                    raise ValueError("Workspace owner mismatch")
                os.fchown(leaf, 1000, 1000)
                os.fchmod(leaf, 0o700)
            finally:
                os.close(leaf)
        finally:
            os.close(parent)
    finally:
        os.close(root_fd)


if __name__ == "__main__":
    try:
        if len(sys.argv) not in (3, 4):
            raise ValueError("Invalid initializer arguments")
        prepare("/pai-fsx", sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) == 4 else None)
    except Exception:
        print("Workspace storage preparation failed", file=sys.stderr)
        sys.exit(1)
