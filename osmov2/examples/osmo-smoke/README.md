# OSMO Smoke

CPU-only smoke workflow for the OSMO control plane and backend.

Run it through the repo wrapper:

```bash
scripts/smoke-test.sh
```

The wrapper submits [workflow.yaml](workflow.yaml), waits for completion, prints logs, and fails fast if the workflow does not complete.

Validation:

- [validation.md](validation.md)
