# Parent-run Isaac Lab GPU integration

The first authorized release-two run on 2026-09-16 was
`a54e6ce49e326950`. It reached the existing GPU node and passed storage/isolation
setup, but failed before Python/CUDA startup: the vendor `/isaac-sim` directory
was mode 0750 for UID/GID 1234, while the dashboard runs UID/GID 1000. There is
**no live training/checkpoint/video success evidence yet**.

`dashboard/images/isaaclab/Dockerfile` now grants 0755 read/traversal access to
that directory and runs `test_image_contract.py` as UID/GID 1000. The original
permission failure and corrected train/play CLI startup were reproduced in the
cached image without a GPU/network. The parent must rebuild/deploy and approve
the updated image before the next full test; CUDA and external asset loading
still need actual validation.

From `dashboard/web`, with the existing parent-injected `DASHBOARD_URL`,
`DASHBOARD_USER`, `DASHBOARD_PASSWORD`, and `DASHBOARD_PROJECT_ID`:

```bash
DASHBOARD_RESEARCHER_LIVE=1 DASHBOARD_ISAACLAB_LIVE=1 npx --no-install playwright test e2e/isaaclab.spec.ts --workers=1 --retries=0 --output=e2e/.results/isaaclab
```

The deployed `ISAACLAB_IMAGE_URI` must already populate the `isaaclab-train` and
`isaaclab-video` templates and resolve to the same approved immutable image.
There is no alternative image, task, CPU simulation, or skipped prerequisite.
The Researcher fixture supplies hosted login, project scoping, authenticated API
calls, credential-free signed transfers, resource journaling, and cleanup.

The test reads the existing ready `ml.g5.8xlarge` node and requires a one-GPU
baseline. Training and playback each request exactly one GPU, 8 CPU, 32 GiB RAM,
and 8 GiB shared memory, with one replica and zero retries. They run sequentially;
the first workflow must fully finalize before the second is submitted. Actual
backend Pod node names must match the preexisting node. The test contains no
scale, node-management, AWS SDK, CLI, or deployment operations.

1. Submit the deployed `isaaclab-train` recipe for `Workshop-SO101-Reach-v0`,
   32 environments, 2 PPO iterations, seed 42, save interval 1, empty resume.
   The only launcher addition is a test-only Python diagnostic that invokes the
   image's unchanged `/opt/recipes/isaaclab/train.py`. MLflow is explicitly
   disabled in this modified test template; this is a GPU learning/video test.
2. Require SUCCEEDED, zero raw/wrapper exit, an artifact receipt, and a READY
   version with a committed manifest. Download the actual `model_0.pt`,
   `model_1.pt`, and `model_final.pt` bytes. Verify full-object SHA256 and size,
   metadata, changed model tensors, advancing Adam state, and finite TensorBoard
   PPO losses at iterations 0 and 1. The image's installed RSL-RL runner uses
   zero-based iteration indices. No learning-success or GPU-utilization numbers
   are invented.
3. Submit `isaaclab-video` with that exact READY dataset version and
   `model_final.pt`, the same Reach task, one rendered environment, and
   `--video --video_length 96 --video_dir {{output}}/videos --headless
   --enable_cameras`. Before calling the baked `play.py`, verify the hydrated
   checkpoint hash and training task metadata. Check the pinned input snapshot.
4. Require a READY video publication and verify the actual MP4 bytes against its
   manifest and test proof. Chromium decodes those verified bytes as a Blob:
   1280×720, finite short duration, and a nonblank frame. This proves rendering,
   not policy quality or a task success rate.

The test-only launcher checks an actual CUDA kernel and synchronization, one
visible GPU, installed recipe/robot asset readability, and FSx write/fsync.
`PAI_ISAACLAB_DIAGNOSTIC` lines classify driver/memory, asset, permission, and
recipe-compatibility failures. Errors fail the test; they do not skip or choose
another task. Timeout/failure attaches bounded, redacted task log tails and own
run IDs. Completed datasets and small proof artifacts remain as evidence.
The image's `python.sh` normalizes a failing Python exit to 1; the diagnostic
JSON retains the cause and, when available, the recipe subprocess's raw exit.

Work has an 18-minute shared deadline and a 20-minute Playwright timeout.
Training/render subprocesses have 7/5-minute limits. Queue/start waits are
bounded; an occupied GPU or a cold pull can exhaust this budget and fail.
The existing fixture has a separate bounded login and up-to-3-minute teardown
for cancellation of this test's own unfinished workflows.

Safe local checks (no authentication, workload submission, or GPU execution):

```bash
npx --no-install tsc -p e2e/tsconfig.researcher.json
npx --no-install playwright test e2e/isaaclab.spec.ts --list
```

The verifier also has 11 CPU-only tests for actual Torch checkpoint decoding,
optimizer advancement, bad/missing state, metadata mismatches, loss events, and
diagnostic redaction. These use unit fixtures and are not GPU training evidence:

```bash
docker run --rm --network none --entrypoint /isaac-sim/python.sh \
  --mount "type=bind,src=$PWD/e2e/researcher-helpers,dst=/e2e,readonly" \
  -w /e2e -e PYTHONDONTWRITEBYTECODE=1 physical-ai-isaaclab:validation \
  -m unittest -v test_isaaclab_probe
```

`researcher-helpers/isaaclab_probe.py` stays under `e2e` and is passed through
the submitted test command only. The web Docker context excludes `e2e`; recipe
image COPY instructions do not include it. The live failure required the image
permission fix above; the test has not changed runtime, engine, infrastructure,
or workload security context.
