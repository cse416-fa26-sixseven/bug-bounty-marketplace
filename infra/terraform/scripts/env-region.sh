#!/usr/bin/env bash
# Region of one environment, read from the committed tfvars (ADR 0002 §8).
#
#   scripts/env-region.sh <env> [--get location|abbr | --check]
#
#   env      test | staging | prod: location / location_abbr of
#            envs/<env>/data.tfvars (the env's source of truth; infra/up.sh
#            --env-location writes it). global: the home region in
#            envs/global/bootstrap.tfvars (tfstate, the shared RG).
#
#   (none)   print KEY=VALUE lines for $GITHUB_ENV or `source <(...)`:
#              BBM_LOCATION, BBM_REGION_ABBR and, for an env, DATA_RG,
#              COMPUTE_RG and CLUSTER; for global, SHARED_RG and TFSTATE_RG
#   --get    print only the region (location) or its code (abbr)
#   --check  fail when BBM_LOCATION / BBM_REGION_ABBR are set (e.g. from the
#            GitHub Environment variables AZURE_LOCATION / AZURE_LOCATION_ABBR)
#            and differ from the tfvars: the bootstrap gh_setup_commands have
#            not been re-run since the region changed
#
# Workflow jobs that are not bound to the env's GitHub Environment (matrix,
# scheduled and read-only jobs) use this instead of the repo variables, which
# hold the home region.
set -euo pipefail

die() {
  echo "env-region: $*" >&2
  exit 1
}

usage() {
  awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "${BASH_SOURCE[0]}" >&2
  exit 2
}

[[ $# -ge 1 ]] || usage
env=$1
shift
mode=all get=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --get)
      [[ $# -ge 2 ]] || usage
      mode=get get=$2
      shift 2
      ;;
    --check) mode=check; shift ;;
    -h | --help) usage ;;
    *) usage ;;
  esac
done

envs_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/envs"
case "$env" in
  test | staging | prod) file="$envs_dir/$env/data.tfvars" ;;
  global) file="$envs_dir/global/bootstrap.tfvars" ;;
  *) die "env must be test, staging, prod or global (got '$env')" ;;
esac
[[ -f "$file" ]] || die "missing $file"

tfvar() { # tfvar <key> → string value of a top-level `key = "value"` line
  sed -nE "s/^$1[[:space:]]*=[[:space:]]*\"([^\"]*)\".*/\1/p" "$file" | head -n1
}
location=$(tfvar location)
abbr=$(tfvar location_abbr)
[[ "$location" =~ ^[a-z][a-z0-9]+$ ]] || die "${file#"$envs_dir/"}: no valid location (got '$location')"
[[ "$abbr" =~ ^[a-z][a-z0-9]{1,5}$ ]] || die "${file#"$envs_dir/"}: no valid location_abbr (got '$abbr')"

case "$mode" in
  get)
    case "$get" in
      location) echo "$location" ;;
      abbr) echo "$abbr" ;;
      *) usage ;;
    esac
    ;;
  check)
    bad=0
    if [[ -n "${BBM_LOCATION:-}" && "$BBM_LOCATION" != "$location" ]]; then
      echo "env-region: BBM_LOCATION=$BBM_LOCATION but envs/$env is in $location" >&2
      bad=1
    fi
    if [[ -n "${BBM_REGION_ABBR:-}" && "$BBM_REGION_ABBR" != "$abbr" ]]; then
      echo "env-region: BBM_REGION_ABBR=$BBM_REGION_ABBR but envs/$env uses $abbr" >&2
      bad=1
    fi
    if [[ $bad == 1 ]]; then
      die "the GitHub Environment's AZURE_LOCATION / AZURE_LOCATION_ABBR are stale: re-run the bootstrap gh_setup_commands (infra/up.sh step 7)"
    fi
    echo "env-region: $env is in $location ($abbr)" >&2
    ;;
  all)
    echo "BBM_LOCATION=$location"
    echo "BBM_REGION_ABBR=$abbr"
    if [[ "$env" == global ]]; then
      echo "SHARED_RG=rg-bbm-shared-$abbr"
      echo "TFSTATE_RG=rg-bbm-tfstate-$abbr"
    else
      echo "DATA_RG=rg-bbm-$env-data-$abbr"
      echo "COMPUTE_RG=rg-bbm-$env-compute-$abbr"
      echo "CLUSTER=aks-bbm-$env-$abbr"
    fi
    ;;
esac
