#!/usr/bin/env bash
# Terraform static checks (no Azure credentials, no backend). CI runs exactly
# this; run it locally from anywhere:
#
#   infra/terraform/scripts/ci-static.sh
#
# Steps, all under infra/terraform:
#   1. terraform fmt -check -recursive
#   2. init -backend=false + validate in every stacks/* and modules/* dir
#      that contains *.tf (new stacks/modules are picked up automatically)
#   3. terraform test in every one of those dirs that has a tests/ folder
#   4. tflint --init + tflint --recursive with the shared .tflint.hcl
#   5. shellcheck scripts/*.sh
#
# Needs terraform, tflint and shellcheck on PATH. Set SKIP_TFLINT=1 or
# SKIP_SHELLCHECK=1 to skip those steps when the tool is not installed.
# init uses a throwaway TF_DATA_DIR per dir (not the dirs' .terraform/), so a
# stack that was once initialised against the real azurerm backend is never
# read or locked from here; modules get a temporary .terraform.lock.hcl that
# is removed again, since lock files are committed for stacks only. Set
# TF_PLUGIN_CACHE_DIR to reuse provider downloads.
set -euo pipefail

tf_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$tf_root"

group() {
  if [[ -n "${GITHUB_ACTIONS:-}" ]]; then echo "::group::$*"; else echo "==> $*"; fi
}
endgroup() {
  if [[ -n "${GITHUB_ACTIONS:-}" ]]; then echo "::endgroup::"; fi
}

if [[ -n "${TF_PLUGIN_CACHE_DIR:-}" ]]; then
  mkdir -p "$TF_PLUGIN_CACHE_DIR"
fi

group "terraform fmt -check -recursive"
terraform fmt -check -recursive -diff .
endgroup

# Every stack/module dir that directly contains a .tf file (while-read
# rather than mapfile so this also runs on macOS bash 3.2).
dirs=()
while IFS= read -r d; do
  dirs+=("$d")
done < <(
  find stacks modules -name '*.tf' -not -path '*/.terraform/*' -not -path '*/tests/*' \
    -exec dirname {} \; | sort -u
)
[[ ${#dirs[@]} -gt 0 ]] || {
  echo "ci-static.sh: no Terraform dirs found under $tf_root" >&2
  exit 1
}

data_root=$(mktemp -d "${TMPDIR:-/tmp}/bbm-ci-static.XXXXXX")
trap 'rm -rf "$data_root"' EXIT

for dir in "${dirs[@]}"; do
  export TF_DATA_DIR="$data_root/${dir//\//_}"
  had_lock=0
  [[ -f "$dir/.terraform.lock.hcl" ]] && had_lock=1

  group "validate $dir"
  terraform -chdir="$dir" init -backend=false -input=false -no-color >/dev/null
  terraform -chdir="$dir" validate -no-color
  endgroup

  if [[ -d "$dir/tests" ]]; then
    group "test $dir"
    terraform -chdir="$dir" test -no-color
    endgroup
  fi

  # Modules must not grow a committed lock file (see README).
  if [[ $had_lock -eq 0 && "$dir" == modules/* ]]; then
    rm -f "$dir/.terraform.lock.hcl"
  fi
done
unset TF_DATA_DIR

if [[ "${SKIP_TFLINT:-}" != "1" ]]; then
  group "tflint"
  tflint --init --config "$tf_root/.tflint.hcl"
  tflint --recursive --config "$tf_root/.tflint.hcl"
  endgroup
fi

if [[ "${SKIP_SHELLCHECK:-}" != "1" ]]; then
  group "shellcheck scripts/*.sh"
  shellcheck scripts/*.sh
  endgroup
fi

echo "ci-static.sh: all Terraform static checks passed (${#dirs[@]} dirs)"
