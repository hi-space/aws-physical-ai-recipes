# Project Memory

This file records current repository context that agents should check before making changes. Update it when project policy, open work, or validated runtime state changes.

## Current Operating Rules

- Default to branch plus PR. Do not push feature, documentation, infrastructure, operations, example, or validation changes directly to `main`.
- Use `codex/*` branch names.
- Keep PRs draft by default unless the user explicitly asks for a ready PR.
- If the user asks to inspect or approve first, stop after preparing the branch or diff and do not push or merge without the user's next instruction.
- Run local validation before pushing and check GitHub Actions after opening or updating a PR.

## Current Repository Context

- The repo is an AWS reference implementation for running NVIDIA OSMO on EKS with validated robotics and physical AI examples.
- NVIDIA OSMO remains an external pinned dependency; this repo owns AWS infrastructure, deployment wrappers, examples, validation records, and compatibility notes.
- `infra/core/` is the baseline AWS infrastructure root.
- `infra/ingress/` is optional HTTPS admin ingress for OSMO UI.
- `infra/observability/` is optional AWS managed observability for AMP, AMG, and Prometheus remote write.
- `docs/osmo-compatibility.md` is for OSMO compatibility notes and upstream patch references.
- `docs/observability.md` is the intended location for AWS managed observability guidance.
- Validation artifacts belong next to the relevant example or infra root, not in a central catch-all validation log.

## Recent Recovery Note

- On 2026-05-05, observability documentation was mistakenly pushed directly to `main`.
- The mistaken main state was preserved on `codex/main-before-o11y-reset`.
- `main` was reset back to the pre-observability commit `6ec4c92`.
- Observability documentation was moved to PR #10 on branch `codex/aws-managed-observability`.
- Do not repeat direct-main observability or feature pushes.
