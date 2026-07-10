# Agent Policy

This file records repository-specific operating rules for AI coding agents working in this repo.

## Git And Release Flow

- Do not push directly to `main` for feature, infrastructure, operations, documentation, validation, or example changes.
- Use a `codex/*` branch and open a pull request for review.
- Treat observability, ingress, storage, workflow examples, validation artifacts, README positioning, and repo-structure changes as PR-sized changes.
- Only push directly to `main` when the user explicitly asks for a direct main push for a narrow change. If the wording includes review language such as "inspect first", "검사받아", or "PR로", stop before pushing and show the proposed change.
- Do not rewrite `main` history unless the user explicitly asks for reset or force push. Prefer preserving the current state on a backup branch first, then use `--force-with-lease`.
- Before branch, commit, push, reset, or force-push operations, run `git status --short --branch` and understand the current branch.
- Never stage unrelated user changes. Stage explicit file paths unless the full worktree is confirmed to be in scope.

## Repository Structure

- Keep OSMO upstream compatibility and patch notes in `docs/osmo-compatibility.md`.
- Keep AWS observability guidance in `docs/observability.md`.
- Keep optional ingress guidance under `infra/ingress/`.
- Keep workflow-specific validation records and artifacts next to the workflow under `examples/<name>/validation.md` and `examples/<name>/validation/`.
- Do not create new top-level docs or infra roots when an existing location fits the change.

## Validation

- For docs-only changes, run:

  ```bash
  npx --yes markdownlint-cli2 "README.md" "docs/**/*.md"
  git diff --check
  ```

- For Terraform changes, also run `terraform fmt -check -recursive` and `terraform validate` for the changed root.
- For shell changes, run syntax checks and shell lint if available.
- For runtime or AWS integration changes, do live validation unless the user explicitly scopes the change to docs-only.
- When the user asks for evidence, leave visual artifacts such as screenshots, videos, plots, logs, or manifests in the repo location that matches the feature or example.
- PR bodies must include the validation commands, runtime evidence, and artifact paths or screenshots when applicable.

## Documentation Style

- State whether a path is a minimal compatibility path, a validated runtime path, or a future recommendation.
- Link to upstream and AWS source docs when the behavior depends on those docs.
- Be explicit about cost and architecture tradeoffs. For example, AMP remote write still keeps an in-cluster collector unless the implementation moves to an agent or ADOT-style collector path.
- Do not overclaim managed-service coverage. Say what is actually deployed and validated.

## Safety

- Do not print tokens, kubeconfigs, AWS secret values, NGC keys, Hugging Face tokens, or service-account token values.
- Do not commit generated Terraform state, tfvars with real values, kubeconfigs, credentials, or local artifacts outside intended validation directories.
- If a mistake reaches `main`, preserve the mistaken state on a branch before cleanup, then follow the user's requested recovery strategy exactly.
