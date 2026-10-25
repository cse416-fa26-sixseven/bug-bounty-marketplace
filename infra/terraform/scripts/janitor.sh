#!/usr/bin/env bash
# Deletes expired ephemeral namespaces on the test AKS cluster (ADR 0002).
#
#   scripts/janitor.sh [--dry-run | --apply]
#
#   --dry-run   list what would be deleted (default)
#   --apply     actually delete
#
# What it does (needs `az login`, kubectl and kubelogin; CI uses the
# gh-bbm-ephemeral OIDC identity, which has AKS RBAC Cluster Admin there):
#   1. Skips cleanly (exit 0) when aks-bbm-test-<region abbr> is not Running
#      (paused or down): nothing on it is billed per namespace, and the next
#      run after a resume catches up.
#   2. Fetches credentials into a temporary kubeconfig (yours is untouched).
#   3. Lists namespaces labelled bbm.io/ephemeral=true and deletes those whose
#      bbm.io/expires-on annotation (RFC3339, UTC) is in the past. Only names
#      run-<run_id>-<attempt> and pr-<n> are ever deleted; anything else, or a
#      namespace without the annotation, is reported and left alone.
#
# Any failed `az` / `kubectl` listing (auth, throttling, ...) fails the run.
#
# It does not touch ACR: the image purge (acr purge --filter 'bbm/.*:pr-.*'
# --filter 'bbm/.*:sha-.*' --ago 30d --keep 10 --untagged) is its own job in
# .github/workflows/infra-janitor.yml, run as gh-bbm-global in the
# reviewer-gated infra-global environment. That job delete-locks the
# staging/prod bbm-last-deployed-tag tags first and fails closed.
#
# Env (optional): BBM_REGION_ABBR (default: location_abbr in
# envs/global/bootstrap.tfvars; CI sets it from repo var AZURE_LOCATION_ABBR).
set -euo pipefail

# Region: BBM_LOCATION / BBM_REGION_ABBR (CI: repo vars AZURE_LOCATION /
# AZURE_LOCATION_ABBR), else location / location_abbr in
# envs/global/bootstrap.tfvars, the single source of truth infra/up.sh writes.
boot_tfvars="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/envs/global/bootstrap.tfvars"
boot_var() { # boot_var <key> → string value from bootstrap.tfvars (empty if absent)
  [[ -f "$boot_tfvars" ]] || return 0
  sed -nE "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*\"([^\"]*)\".*/\1/p" "$boot_tfvars" | head -n1
}
abbr=${BBM_REGION_ABBR:-$(boot_var location_abbr)}
[[ -n "$abbr" ]] || { echo "janitor: region unknown: set BBM_REGION_ABBR" >&2; exit 1; }
compute_rg="rg-bbm-test-compute-$abbr"
cluster="aks-bbm-test-$abbr"
name_re='^(run-[0-9]+-[0-9]+|pr-[0-9]+)$'

dry_run=true

die() {
  echo "janitor: $*" >&2
  exit 1
}

log() {
  echo "janitor: $*"
}

usage() {
  awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "${BASH_SOURCE[0]}" >&2
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) dry_run=false ;;
    --dry-run) dry_run=true ;;
    -h | --help) usage ;;
    *) die "unknown argument '$1' (see --help)" ;;
  esac
  shift
done

for bin in az kubectl kubelogin; do
  command -v "$bin" >/dev/null || die "$bin not found on PATH"
done
az account show --only-show-errors >/dev/null 2>&1 || die "not logged in: run 'az login' (or azure/login in CI)"

# Compared as strings on the first 19 chars (YYYY-MM-DDTHH:MM:SS), which
# orders correctly for UTC values.
now=$(date -u +%Y-%m-%dT%H:%M:%S)

mode="DRY RUN"
$dry_run || mode="APPLY"
log "mode: $mode, now: ${now}Z, cluster: $cluster"

# 1. Only a running cluster can (and needs to) be swept. `list` so a missing
# cluster or RG is an empty result, not an error.
if [[ "$(az group exists --name "$compute_rg" --only-show-errors)" != "true" ]]; then
  log "resource group $compute_rg not found (test env down?); nothing to do"
  exit 0
fi
state=$(az aks list -g "$compute_rg" \
  --query "[?name=='$cluster'] | [0].[powerState.code, provisioningState]" -o tsv --only-show-errors) ||
  die "reading $cluster state failed"
state=$(tr '\t' ' ' <<<"$state")
if [[ "$state" != "Running Succeeded" ]]; then
  log "$cluster is '${state:-not found}', not 'Running Succeeded'; skipping (nothing billed per namespace)"
  exit 0
fi

# 2. Credentials in a throwaway kubeconfig.
kubeconfig=$(mktemp)
trap 'rm -f "$kubeconfig"' EXIT
export KUBECONFIG=$kubeconfig
az aks get-credentials -g "$compute_rg" -n "$cluster" --format azure \
  --file "$kubeconfig" --overwrite-existing --only-show-errors >/dev/null
kubelogin convert-kubeconfig -l azurecli --kubeconfig "$kubeconfig"

# 3. Expired ephemeral namespaces.
out=$(kubectl get namespaces -l bbm.io/ephemeral=true \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.metadata.annotations.bbm\.io/expires-on}{"\t"}{.status.phase}{"\n"}{end}') ||
  die "listing namespaces failed"

expired=()
total=0
while IFS=$'\t' read -r ns expires phase; do
  [[ -n "$ns" ]] || continue
  total=$((total + 1))
  if [[ ! "$ns" =~ $name_re ]]; then
    log "skip (name is not run-<id>-<attempt> or pr-<n>): $ns"
    continue
  fi
  if [[ -z "$expires" ]]; then
    log "skip (no bbm.io/expires-on annotation): $ns"
    continue
  fi
  if [[ "$phase" == "Terminating" ]]; then
    log "already terminating: $ns"
    continue
  fi
  if [[ "${expires:0:19}" < "$now" ]]; then
    log "delete namespace: $ns (expired $expires)"
    expired+=("$ns")
  else
    log "keep: $ns (expires $expires)"
  fi
done <<<"$out"

if [[ ${#expired[@]} -eq 0 ]]; then
  log "nothing expired ($total ephemeral namespaces)"
elif ! $dry_run; then
  # --wait=false: finalizers (PVCs, LB services) can take minutes; the
  # namespace is gone from the next listing's "delete" set either way.
  kubectl delete namespace "${expired[@]}" --wait=false
fi

log "done ($mode)"
