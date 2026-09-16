"""Canonical checkpoint-directory identity shared by policy/evaluation adapters.

Matches dashboard/web/src/server/evaluations/bundles.ts. Neither a directory
digest nor this inventory is the SHA256 of its enclosing model.tar.gz.
"""
import hashlib
import os
from pathlib import Path
import stat
import tarfile

ALGORITHM = "pai-directory-sha256-v1"
MAX_FILES = 10000
MAX_BYTES = 100 * 1024 ** 3


def safe_path(name):
    while name.startswith("./"):
        name = name[2:]
    name = name.rstrip("/")
    if (not name or name.startswith("/") or len(name) > 2048 or "\\" in name or ":" in name
            or any(ord(c) < 32 for c in name) or any(p in ("", ".", "..") for p in name.split("/"))):
        raise ValueError("unsafe checkpoint path")
    return name


def manifest(files):
    if not files or len(files) > MAX_FILES:
        raise ValueError("checkpoint bundle must contain 1-10000 files")
    ordered = sorted(files, key=lambda file: file["path"].encode("utf-8"))
    if len({file["path"] for file in files}) != len(files):
        raise ValueError("duplicate checkpoint path")
    value = hashlib.sha256()
    for file in ordered:
        path = safe_path(file["path"])
        value.update(f'{len(path.encode("utf-8"))}:{path}\0{file["bytes"]}\0{file["sha256"]}\n'.encode("utf-8"))
    return {"schemaVersion": 1, "algorithm": ALGORITHM, "digest": value.hexdigest(), "files": ordered}


def _hash(stream, expected=None):
    value, size = hashlib.sha256(), 0
    while chunk := stream.read(1024 * 1024):
        size += len(chunk)
        if size > MAX_BYTES or expected is not None and size > expected:
            raise ValueError("checkpoint file exceeds declared size")
        value.update(chunk)
    if expected is not None and expected != size:
        raise ValueError("truncated checkpoint file")
    return size, value.hexdigest()


def inspect_checkpoint(path, extract_to=None):
    """Inspect a real directory or tar.gz; optionally extract regular tar members
    into a new private directory. Never follow links or write outside that root."""
    path = Path(path)
    if path.is_symlink():
        raise ValueError("checkpoint root must not be a symlink")
    files, total = [], 0
    if path.is_dir():
        for root, dirs, names in os.walk(path, followlinks=False):
            if any((Path(root) / name).is_symlink() for name in dirs):
                raise ValueError("checkpoint directory contains a symlink")
            for name in names:
                entry = Path(root) / name
                fd = os.open(entry, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
                with os.fdopen(fd, "rb") as stream:
                    before = os.fstat(stream.fileno())
                    if not stat.S_ISREG(before.st_mode):
                        raise ValueError("checkpoint contains a special file")
                    size, sha = _hash(stream, before.st_size)
                    after = os.fstat(stream.fileno())
                    if (before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (
                            after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
                        raise ValueError("checkpoint changed while hashing")
                total += size
                files.append({"path": str(entry.relative_to(path)), "bytes": size, "sha256": sha})
                if total > MAX_BYTES or len(files) > MAX_FILES:
                    raise ValueError("checkpoint bundle exceeds limit")
        return path, manifest(files)
    if not path.name.endswith(".tar.gz"):
        raise ValueError("checkpoint must be a directory or model.tar.gz")
    destination = Path(extract_to) if extract_to is not None else None
    if destination:
        destination.mkdir(parents=True, exist_ok=False)
    seen = set()
    with tarfile.open(path, "r|gz") as archive:
        for member in archive:
            if member.isdir() and member.name in (".", "./"):
                continue
            name = safe_path(member.name)
            if name in seen or not (member.isfile() or member.isdir()) or member.issparse():
                raise ValueError("duplicate, linked or unsupported tar member")
            seen.add(name)
            if member.isdir():
                if member.size:
                    raise ValueError("directory tar member has data")
                if destination:
                    (destination / name).mkdir(parents=True, exist_ok=True)
                continue
            if len(files) >= MAX_FILES or member.size < 0 or total + member.size > MAX_BYTES:
                raise ValueError("checkpoint archive exceeds limit")
            source = archive.extractfile(member)
            if source is None:
                raise ValueError("missing tar member bytes")
            value, size = hashlib.sha256(), 0
            target = None
            try:
                if destination:
                    target_path = destination / name
                    target_path.parent.mkdir(parents=True, exist_ok=True)
                    target = target_path.open("xb")
                while chunk := source.read(1024 * 1024):
                    size += len(chunk)
                    if size > member.size:
                        raise ValueError("tar member exceeded declared size")
                    value.update(chunk)
                    if target:
                        target.write(chunk)
                if size != member.size:
                    raise ValueError("truncated tar member")
            finally:
                source.close()
                if target:
                    target.close()
            total += size
            files.append({"path": name, "bytes": size, "sha256": value.hexdigest()})
    return destination or path, manifest(files)
