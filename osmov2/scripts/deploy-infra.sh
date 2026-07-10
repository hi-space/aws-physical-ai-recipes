#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=./scripts/common.sh
# shellcheck disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

require_cmds aws terraform

terraform -chdir="${TF_DIR}" init -input=false
terraform -chdir="${TF_DIR}" apply "$@"
