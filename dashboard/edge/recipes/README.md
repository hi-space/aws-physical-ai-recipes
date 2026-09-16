# Concrete recipe generation

These commands render recipes only. They do not upload an artifact, publish a component, create a Thing, or deploy.

First build the bundle locally:

```bash
python dashboard/edge/build_bundle.py --output-dir /tmp/physical-ai-edge-bundle
```

The output filename is its SHA-256 plus `.zip`. The parent must publish that exact ZIP to an owned, immutable S3 key, then supply:

- `COMPONENT_VERSION`: an actual new semantic component version.
- `BUNDLE_URI`: the owned content-addressed `s3://.../<sha256>.zip` key.
- `RUNTIME_IMAGE_DIGEST_URI`: an existing compatible workload image ending in `@sha256:<digest>` (not needed for communication).

CPU PPO inference:

```bash
python dashboard/edge/build_recipe.py \
  --name com.physicalai.inference --version "$COMPONENT_VERSION" \
  --purpose inference --engine sb3-ppo --architecture amd64 \
  --artifact-uri "$BUNDLE_URI" --runtime-image "$RUNTIME_IMAGE_DIGEST_URI" \
  --output /tmp/physical-ai-inference.json
```

CPU PPO benchmark:

```bash
python dashboard/edge/build_recipe.py \
  --name com.physicalai.benchmark --version "$COMPONENT_VERSION" \
  --purpose benchmark --engine sb3-ppo --architecture amd64 \
  --artifact-uri "$BUNDLE_URI" --runtime-image "$RUNTIME_IMAGE_DIGEST_URI" \
  --output /tmp/physical-ai-benchmark.json
```

Communication-only harness for a **new owned nonphysical test Core**:

```bash
python dashboard/edge/build_recipe.py \
  --name com.physicalai.communication --version "$COMPONENT_VERSION" \
  --purpose communication --engine virtual-communication --architecture amd64 \
  --artifact-uri "$BUNDLE_URI" --output /tmp/physical-ai-communication.json
```

Use `--architecture arm64` only with a matching published image/component platform and registered Core. GR00T PyTorch uses `--engine groot-pytorch` and a complete pinned model directory archive; GPU/Jetson execution remains unverified until the parent provisions and tests it.

The default execution configuration is empty on purpose. The dashboard prepares the full target/model/version/report configuration before explicit submit. Manually deploying the recipe without that configuration fails instead of launching an assumed model path.

The original workshop mutable-path recipes are reference/provenance sources, not compatible replacements for this pinned-artifact contract.
