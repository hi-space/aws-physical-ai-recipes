"""Render a concrete Greengrass recipe; never publish or deploy it."""
import argparse
import json
from pathlib import Path
import re


def recipe(name, version, purpose, engine, architecture, artifact_uri, runtime_image=None):
    if not re.fullmatch(r"[A-Za-z0-9_.-]{1,128}", name) or not re.fullmatch(r"\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?", version):
        raise ValueError("explicit component name and semantic version required")
    archive = re.fullmatch(r"s3://[a-z0-9.-]+/[A-Za-z0-9/_-]*/([a-f0-9]{64})\.zip", artifact_uri)
    if not archive:
        raise ValueError("component bundle URI must use a content-addressed SHA256.zip filename")
    if architecture not in ("amd64", "arm64") or purpose not in ("inference", "benchmark", "communication"):
        raise ValueError("unsupported architecture/purpose")
    formats = {"sb3-ppo": "mujoco-ppo-bundle", "groot-pytorch": "groot-directory-tar", "virtual-communication": "none"}
    if engine not in formats or (purpose == "communication") != (engine == "virtual-communication"):
        raise ValueError("engine and purpose disagree")
    if purpose != "communication" and not re.fullmatch(r"\S+@sha256:[a-f0-9]{64}", runtime_image or ""):
        raise ValueError("runtime image must be pinned by digest")
    root = "{artifacts:decompressedPath}/" + archive.group(1)
    defaults = {"edgeContract": "physical-ai-pinned-v1", "purpose": purpose, "engine": engine,
                "modelFormat": formats[engine], "execution": "{}"}
    if runtime_image:
        defaults["runtimeImage"] = runtime_image
    return {
        "RecipeFormatVersion": "2020-01-25", "ComponentName": name, "ComponentVersion": version,
        "ComponentDescription": "Version-pinned Physical AI " + purpose + "; no actuator control",
        "ComponentPublisher": "Project administrator",
        "ComponentDependencies": {"aws.greengrass.TokenExchangeService": {"VersionRequirement": "^2.0.0", "DependencyType": "HARD"}},
        "ComponentConfiguration": {"DefaultConfiguration": defaults},
        "Manifests": [{
            "Platform": {"os": "linux", "architecture": "aarch64" if architecture == "arm64" else "amd64"},
            "Artifacts": [{"Uri": artifact_uri, "Unarchive": "ZIP"}],
            "Lifecycle": {
                "Setenv": {"PYTHONPATH": root + "/vendor", "EDGE_EXECUTION_CONFIG": "{configuration:/execution}"},
                "Run": {"Script": f"python3 -u {root}/edge_agent.py", "RequiresPrivilege": False},
            },
        }],
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for flag in ("name", "version", "purpose", "engine", "architecture", "artifact-uri", "output"):
        parser.add_argument("--" + flag, required=True)
    parser.add_argument("--runtime-image")
    args = parser.parse_args()
    result = recipe(args.name, args.version, args.purpose, args.engine, args.architecture, args.artifact_uri, args.runtime_image)
    Path(args.output).write_text(json.dumps(result, indent=2) + "\n")
