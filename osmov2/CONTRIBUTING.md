# Contributing

This repository is intentionally small. Contributions should keep NVIDIA OSMO external and pinned, and should avoid adding vendored upstream code, generated Terraform state, kubeconfigs, Helm values, or tokens.

## Pull Requests

Before opening a pull request:

- Update `versions.yaml` for dependency changes.
- Keep baseline infrastructure changes in `infra/core/`.
- Keep optional FSx for Lustre storage integration changes in `infra/fsx/`.
- Keep optional HTTPS admin ingress changes in `infra/ingress/`.
- Keep operational wrappers in `scripts/`.
- Keep workflows in `examples/`.
- Add or update docs when behavior, security posture, or compatibility changes.

Run the local static checks:

```bash
terraform -chdir=infra/core fmt -check -recursive
terraform -chdir=infra/core init -backend=false -input=false
terraform -chdir=infra/core validate
terraform -chdir=infra/fsx fmt -check -recursive
terraform -chdir=infra/fsx init -backend=false -input=false
terraform -chdir=infra/fsx validate
terraform -chdir=infra/ingress fmt -check -recursive
terraform -chdir=infra/ingress init -backend=false -input=false
terraform -chdir=infra/ingress validate
bash -n scripts/*.sh
scripts/scan-public-ingress.sh
```

When a change affects deployment behavior, run the clean-account validation sequence from `docs/reproducibility.md` and summarize the result in the PR.

## Security

Do not open public issues for suspected security vulnerabilities. Follow the AWS vulnerability reporting process: <https://aws.amazon.com/security/vulnerability-reporting/>.
