"""Build a content-addressed component ZIP with vendored SDK; no AWS operations."""
import argparse
import hashlib
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import zipfile


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()
    source = Path(__file__).parent
    output = Path(args.output_dir)
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="edge-bundle-") as folder:
        stage = Path(folder)
        subprocess.run([sys.executable, "-m", "pip", "install", "--ignore-installed", "--no-warn-conflicts", "--no-cache-dir", "--target", str(stage / "vendor"),
                        "-r", str(source / "requirements.txt")], check=True)
        for name in ("edge_agent.py", "runtime.py", "virtual_device.py"):
            shutil.copyfile(source / name, stage / name)
        archive = output / "component.zip"
        with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as bundle:
            for file in sorted(stage.rglob("*")):
                if file.is_file() and "__pycache__" not in file.parts:
                    bundle.write(file, file.relative_to(stage))
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        final = archive.with_name(digest + ".zip")
        archive.rename(final)
        print(final)
