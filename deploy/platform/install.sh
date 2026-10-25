#!/usr/bin/env bash
# Install or upgrade the per-cluster platform layer (ADR 0002 section 3):
#   1. jetstack cert-manager (release cert-manager, namespace cert-manager)
#   2. deploy/helm/bbm-platform (release bbm-platform, namespace bbm-platform):
#      ClusterIssuers, the env wildcard Certificate, NginxIngressController bbm
#
# Idempotent: safe to re-run. Assumes the current kubectl context already
# points at the env's cluster (az aks get-credentials + kubelogin).
set -euo pipefail

CERT_MANAGER_VERSION="v1.21.3"
CERT_MANAGER_REPO="https://charts.jetstack.io"
CERT_TIMEOUT="600s"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PLATFORM_CHART="$REPO_ROOT/deploy/helm/bbm-platform"
CM_VALUES="$SCRIPT_DIR/cert-manager-values.yaml"

usage() {
  cat <<EOF
Usage: deploy/platform/install.sh <env> --values <values-infra.yaml> [--issuer letsencrypt-prod|letsencrypt-staging] [--wait]

Installs cert-manager ${CERT_MANAGER_VERSION} and the bbm-platform chart into the
cluster of the current kubectl context.

  <env>               test | staging | prod (selects deploy/helm/bbm-platform/values-<env>.yaml)
  --values FILE       values-infra.yaml (terraform: tf.sh compute <env> output -raw helm_values)
  --issuer NAME       ClusterIssuer for the wildcard certificate (default letsencrypt-prod)
  --wait              wait up to ${CERT_TIMEOUT} for Certificate bbm-platform/bbm-wildcard to be Ready
  -h, --help          show this help
EOF
}

die() { echo "error: $*" >&2; exit 1; }

env_name=""
values_file=""
issuer=""
wait_cert=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h | --help) usage; exit 0 ;;
    --values) [[ $# -ge 2 ]] || die "--values needs a file"; values_file="$2"; shift 2 ;;
    --values=*) values_file="${1#*=}"; shift ;;
    --issuer) [[ $# -ge 2 ]] || die "--issuer needs a name"; issuer="$2"; shift 2 ;;
    --issuer=*) issuer="${1#*=}"; shift ;;
    --wait) wait_cert=true; shift ;;
    -*) usage >&2; die "unknown option: $1" ;;
    *)
      [[ -z "$env_name" ]] || die "unexpected argument: $1"
      env_name="$1"; shift ;;
  esac
done

[[ -n "$env_name" ]] || { usage >&2; die "missing <env>"; }
case "$env_name" in test | staging | prod) ;; *) die "env must be test, staging or prod (got '$env_name')" ;; esac
[[ -n "$values_file" ]] || { usage >&2; die "missing --values <values-infra.yaml>"; }
[[ -s "$values_file" ]] || die "values file not found or empty: $values_file"
case "$issuer" in "" | letsencrypt-prod | letsencrypt-staging) ;; *) die "--issuer must be letsencrypt-prod or letsencrypt-staging" ;; esac

for bin in helm kubectl python3; do
  command -v "$bin" >/dev/null || die "$bin not found on PATH"
done

env_values="$PLATFORM_CHART/values-$env_name.yaml"
[[ -f "$env_values" ]] || die "missing $env_values"

# platform.certManagerClientId from values-infra.yaml. PyYAML when present,
# else a minimal two-level scan (enough for terraform's yamlencode output),
# so no extra dependency is needed.
client_id="$(python3 -I - "$values_file" <<'PY'
import re, sys
path = sys.argv[1]
text = open(path, encoding="utf-8").read()
value = None
try:
    import yaml
    value = ((yaml.safe_load(text) or {}).get("platform") or {}).get("certManagerClientId")
except ImportError:
    in_platform = False
    for line in text.splitlines():
        if re.match(r'^["\']?platform["\']?\s*:\s*$', line):
            in_platform = True
            continue
        if in_platform and re.match(r"^\S", line):
            in_platform = False
        if in_platform:
            m = re.match(r'^\s+["\']?certManagerClientId["\']?\s*:\s*["\']?([^"\'\s#]*)', line)
            if m:
                value = m.group(1)
                break
print(value or "")
PY
)"
[[ "$client_id" =~ ^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$ ]] ||
  die "platform.certManagerClientId missing or not a GUID in $values_file (got '$client_id')"

context="$(kubectl config current-context 2>/dev/null || true)"
[[ -n "$context" ]] || die "no current kubectl context (run az aks get-credentials first)"
echo "==> env=$env_name context=$context cert-manager=$CERT_MANAGER_VERSION"
[[ "$context" == *"bbm-$env_name"* ]] ||
  echo "warning: context '$context' does not look like the $env_name cluster (aks-bbm-$env_name-eus2)" >&2

echo "==> cert-manager $CERT_MANAGER_VERSION (namespace cert-manager)"
helm upgrade --install cert-manager cert-manager \
  --repo "$CERT_MANAGER_REPO" --version "$CERT_MANAGER_VERSION" \
  --namespace cert-manager --create-namespace \
  -f "$CM_VALUES" \
  --set-string "serviceAccount.annotations.azure\.workload\.identity/client-id=$client_id" \
  --wait --timeout 10m

platform_args=(
  upgrade --install bbm-platform "$PLATFORM_CHART"
  --namespace bbm-platform --create-namespace
  -f "$env_values"
  -f "$values_file"
  --atomic --wait --timeout 5m
)
[[ -z "$issuer" ]] || platform_args+=(--set "certificate.issuer=$issuer")

# Right after a fresh cert-manager install its webhook can still be getting
# its CA injected and reject the ClusterIssuers; --atomic rolls a failed
# attempt back, so retrying is clean.
echo "==> bbm-platform (namespace bbm-platform)"
for attempt in 1 2 3 4 5; do
  if helm "${platform_args[@]}"; then
    break
  fi
  [[ $attempt -lt 5 ]] || die "bbm-platform install failed after $attempt attempts"
  echo "bbm-platform install failed (attempt $attempt), retrying in 15s..." >&2
  sleep 15
done

if [[ "$wait_cert" == true ]]; then
  echo "==> waiting up to $CERT_TIMEOUT for Certificate bbm-platform/bbm-wildcard"
  if ! kubectl -n bbm-platform wait certificate/bbm-wildcard --for=condition=Ready --timeout="$CERT_TIMEOUT"; then
    echo "error: Certificate bbm-platform/bbm-wildcard is not Ready" >&2
    kubectl -n bbm-platform describe certificate bbm-wildcard >&2 || true
    kubectl -n bbm-platform get certificaterequests,orders.acme.cert-manager.io -o wide >&2 || true
    kubectl get challenges.acme.cert-manager.io -A -o wide >&2 || true
    kubectl -n bbm-platform describe challenges.acme.cert-manager.io >&2 || true
    exit 1
  fi
fi

echo "==> platform ready on $context"
kubectl -n bbm-platform get certificate bbm-wildcard 2>/dev/null || true
