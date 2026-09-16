# MuJoCo checkpoint recovery

`train.py --resume <bundle>` retains its explicit trusted-bundle behavior.
With an empty `--resume`, it consumes the runtime's `PAI_RESUME_CHECKPOINTS`
mapping only when a valid private restore receipt exists inside the **new**
output directory. It selects a complete compatible PPO bundle by highest
timesteps, then optimizer updates, preferring `final` on a tie. Hidden partial
bundles are ignored; corruption or an invalid nonempty restore fails visibly.

PPO weights, optimizer tensors and VecNormalize statistics are restored.
`initial/` records the restored state before learning, while all additional
checkpoints and final output are written into the new directory.
`training.json` records `resumeSource` (`fresh`, `explicit`, or `runtime`) and
`resumeBundle`. Simulator and RNG state begin from the configured seed;
this is not exact simulator-state continuation.

Halley's builtin should keep `--resume` optional/empty and declare:

```yaml
checkpoint:
  - path: "{{output}}"
    url: auto
    frequency: 30s
    regex: '^(final|checkpoints/step-[0-9]+)/(model\.zip|vecnormalize\.pkl|manifest\.json)$'
exitActions: { COMPLETE: 0, RESCHEDULE: 75 }
retry: { max_retries: 1 }
```

Only trusted project checkpoint data should be used: SB3 and normalization
bundles contain serialized Python state. Broker version/checksum verification
and server-owned retry lineage precede this model-level selection.

## Local verification without AWS

Mount this updated recipes directory read-only into the cached
`physical-ai-mujoco:recipe-test` image and provide a newly built static runtime
as `PAI_RUNTIME_TEST_BINARY`.

```sh
python -m unittest discover -s /opt/recipes/mujoco -p 'test*.py' -v
```

The integration test uses a loopback broker/storage fixture and the **real Go
runtime** to upload and restore real trained PPO files. It removes attempt 1's
entire local output before attempt 2. It then compares initial weights,
optimizer tensors and normalization arrays/counts exactly, and verifies
continued training from 128 to 192 timesteps with `--resume` empty.

Four tests passed in the cached CPU image with Docker networking disabled,
including the existing explicit-resume/evaluation regression (194.264 seconds).
No first-release image tag was overwritten and no image was pushed.
