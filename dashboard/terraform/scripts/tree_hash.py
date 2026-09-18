#!/usr/bin/env python3
"""Content hash of a Docker build context honoring simple ignore rules (external data source).

stdin: {"directory": ..., "exclude": "a,b,c"} — excluded names are matched against every path
segment, so "node_modules" also skips nested copies. Output: {"hash": <sha256>}.
"""
import hashlib
import json
import sys
from pathlib import Path


def main() -> None:
    query = json.load(sys.stdin)
    root = Path(query["directory"]).resolve()
    excluded = {name for name in query.get("exclude", "").split(",") if name}
    digest = hashlib.sha256()
    for path in sorted(p for p in root.rglob("*") if p.is_file()):
        rel = path.relative_to(root)
        if any(part in excluded or any(part.endswith(suffix[1:]) for suffix in excluded if suffix.startswith("*")) for part in rel.parts):
            continue
        digest.update(rel.as_posix().encode())
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    print(json.dumps({"hash": digest.hexdigest()}))


if __name__ == "__main__":
    main()
