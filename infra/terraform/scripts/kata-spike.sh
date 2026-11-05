#!/usr/bin/env bash
# Kata spike: proves that the `sandbox` node pool of an env runs pods under
# VM isolation (ADR 0004 §5). Run it right after `tf.sh compute <env> apply`
# enabled the pool, before trusting the pool with auditor PoCs.
#
#   scripts/kata-spike.sh <env> [<image tag>] [--acr <name>]
#
#   env        test | staging | prod
#   image tag  tag of <acr>.azurecr.io/bbm/sandbox to run (sha-<7>). Default:
#              the env's bbm-last-deployed-tag (data RG tag written by
#              deploy.yml); test has none, so pass one (e.g. the sha-<7> of
#              the latest integration-azure.yml run)
#   --acr      registry name (default: ACR_NAME, else acrbbm<suffix> from
#              envs/global/global.tfvars)
#
# What it does (needs `az login`, kubectl and kubelogin; AKS RBAC on the env's
# cluster):
#   1. az aks get-credentials for aks-bbm-<env>-<abbr> into a temporary
#      kubeconfig (yours is untouched); checks RuntimeClass kata-vm-isolation
#      exists (the pool's workload runtime installs it).
#   2. Creates namespace kata-spike and a Pod with runtimeClassName
#      kata-vm-isolation, nodeSelector bbm.io/pool=sandbox, the bbm.io/sandbox
#      toleration and the sandbox image, running
#        sh -c 'uname -r; forge --version; nproc; free -m'
#      with the sandbox Job's security context (non-root, read-only root,
#      no capabilities, no SA token, 1 CPU / 1 GiB).
#   3. Waits up to 10 min (the pool scales 0 -> 1, 3-5 min), prints the pod
#      log and the node's kernel next to the guest's.
#   4. Always deletes the namespace. Exit 0 only if the pod ran to completion
#      AND the guest kernel differs from the node's (i.e. it ran in a Kata
#      VM, not under runc). A runc fallback is never silently accepted; see
#      ADR 0004 for the ACI fallback.
#
# Env (optional): BBM_REGION_ABBR (default: location_abbr in envs/<env>/data.tfvars),
# ACR_NAME, KATA_SPIKE_TIMEOUT (seconds, 600).
set -euo pipefail

die() {
  echo "kata-spike: $*" >&2
  exit 1
}

log() {
  echo "kata-spike: $*"
}

usage() {
  awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "${BASH_SOURCE[0]}" >&2
  exit 2
}

[[ $# -ge 1 ]] || usage
env=$1
shift
tag=""
acr=${ACR_NAME:-}
while [[ $# -gt 0 ]]; do
  case "$1" in
    --acr)
      [[ $# -ge 2 ]] || usage
      acr=$2
      shift 2
      ;;
    --acr=*)
      acr=${1#*=}
      shift
      ;;
    -h | --help) usage ;;
    -*) die "unknown option '$1' (see --help)" ;;
    *)
      [[ -z "$tag" ]] || usage
      tag=$1
      shift
      ;;
  esac
done
case "$env" in test | staging | prod) ;; *) die "env must be test, staging or prod (got '$env')" ;; esac

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
abbr=${BBM_REGION_ABBR:-$("$here/env-region.sh" "$env" --get abbr)} || die "region of $env unknown"
[[ -n "$abbr" ]] || die "region unknown: set BBM_REGION_ABBR (or location_abbr in envs/$env/data.tfvars)"
data_rg="rg-bbm-$env-data-$abbr"
compute_rg="rg-bbm-$env-compute-$abbr"
cluster="aks-bbm-$env-$abbr"
timeout=${KATA_SPIKE_TIMEOUT:-600}
ns=kata-spike
pod=kata-spike

if [[ -z "$acr" ]]; then
  suffix=$(sed -nE 's/^suffix[[:space:]]*=[[:space:]]*"([^"]*)".*/\1/p' "$here/../envs/global/global.tfvars" | head -n1)
  [[ -n "$suffix" && "$suffix" != "0000" ]] || die "cannot derive the registry name (no suffix in envs/global/global.tfvars): pass --acr <name> or set ACR_NAME"
  acr="acrbbm$suffix"
fi
[[ "$acr" =~ ^[a-z0-9]{5,50}$ ]] || die "invalid registry name '$acr'"

for bin in az kubectl kubelogin; do
  command -v "$bin" >/dev/null || die "$bin not found on PATH"
done
az account show --only-show-errors >/dev/null 2>&1 || die "not logged in: run 'az login'"

if [[ -z "$tag" ]]; then
  tag=$(az group show --name "$data_rg" --query 'tags."bbm-last-deployed-tag"' -o tsv --only-show-errors 2>/dev/null || true)
  if [[ -z "$tag" || "$tag" == "None" ]]; then
    die "$data_rg has no bbm-last-deployed-tag ($env never deployed; test never is): pass the image tag, e.g. the sha-<7> of the latest integration-azure.yml run"
  fi
fi
[[ "$tag" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] || die "invalid image tag '$tag'"
image="$acr.azurecr.io/bbm/sandbox:$tag"
log "env $env ($abbr), cluster $cluster, image $image"

# 1. Credentials in a throwaway kubeconfig; the namespace is removed on exit.
kubeconfig=$(mktemp)
cleanup() {
  local rc=$?
  if [[ -n "${created:-}" ]]; then
    log "deleting namespace $ns"
    kubectl delete namespace "$ns" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  fi
  rm -f "$kubeconfig"
  exit "$rc"
}
trap cleanup EXIT
export KUBECONFIG=$kubeconfig
az aks get-credentials -g "$compute_rg" -n "$cluster" --format azure \
  --file "$kubeconfig" --overwrite-existing --only-show-errors >/dev/null ||
  die "could not get credentials for $cluster in $compute_rg (is $env up?)"
kubelogin convert-kubeconfig -l azurecli --kubeconfig "$kubeconfig"

kubectl get runtimeclass kata-vm-isolation >/dev/null 2>&1 ||
  die "RuntimeClass kata-vm-isolation is missing on $cluster: the sandbox pool (workload_runtime KataVmIsolation) is not applied; run tf.sh compute $env apply with sandbox_pool_enabled = true"
pool_nodes=$(kubectl get nodes -l bbm.io/pool=sandbox -o name | wc -l)
log "sandbox pool nodes right now: $pool_nodes (0 = the autoscaler adds one, 3-5 min)"

# 2. Namespace and pod. The pod mirrors the PoC Job's security context
# (deploy/helm/bbm sandbox.jobTemplate), so the spike proves the same shape
# the worker will run.
kubectl create namespace "$ns" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
created=1
kubectl label namespace "$ns" --overwrite \
  pod-security.kubernetes.io/enforce=restricted bbm.io/kata-spike=true >/dev/null
kubectl apply -n "$ns" -f - <<YAML >/dev/null
apiVersion: v1
kind: Pod
metadata:
  name: $pod
spec:
  runtimeClassName: kata-vm-isolation
  restartPolicy: Never
  automountServiceAccountToken: false
  enableServiceLinks: false
  activeDeadlineSeconds: $timeout
  nodeSelector:
    bbm.io/pool: sandbox
  tolerations:
    - key: bbm.io/sandbox
      operator: Equal
      value: "true"
      effect: NoSchedule
  securityContext:
    runAsNonRoot: true
    runAsUser: 10001
    runAsGroup: 10001
    seccompProfile:
      type: RuntimeDefault
  containers:
    - name: spike
      image: $image
      command: ["sh", "-c", "uname -r; forge --version; nproc; free -m"]
      env:
        - name: HOME
          value: /tmp
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities:
          drop: ["ALL"]
      resources:
        requests: { cpu: "1", memory: 1Gi }
        limits: { cpu: "1", memory: 1Gi }
      volumeMounts:
        - name: tmp
          mountPath: /tmp
  volumes:
    - name: tmp
      emptyDir:
        sizeLimit: 256Mi
YAML

# 3. Wait for a terminal phase (Succeeded / Failed), up to $timeout seconds.
log "waiting up to ${timeout}s for the pod to finish"
deadline=$((SECONDS + timeout))
phase=""
last=""
while ((SECONDS < deadline)); do
  phase=$(kubectl get pod -n "$ns" "$pod" -o jsonpath='{.status.phase}' 2>/dev/null || true)
  [[ "$phase" == Succeeded || "$phase" == Failed ]] && break
  state="$phase $(kubectl get pod -n "$ns" "$pod" \
    -o jsonpath='{.status.containerStatuses[0].state.waiting.reason}{.spec.nodeName}' 2>/dev/null || true)"
  if [[ "$state" != "$last" ]]; then
    log "pod: ${state:-not found yet}"
    last=$state
  fi
  sleep 10
done

echo "----- pod -----"
kubectl get pod -n "$ns" "$pod" -o wide || true
if [[ "$phase" != Succeeded && "$phase" != Failed ]]; then
  echo "----- events -----"
  kubectl get events -n "$ns" --sort-by=.lastTimestamp || true
  die "pod did not finish within ${timeout}s (phase '${phase:-none}'); see the events above (quota, taint, image pull, Kata runtime)"
fi

echo "----- pod log -----"
logs=$(kubectl logs -n "$ns" "$pod" 2>&1 || true)
echo "$logs"
node=$(kubectl get pod -n "$ns" "$pod" -o jsonpath='{.spec.nodeName}')
node_kernel=$(kubectl get node "$node" -o jsonpath='{.status.nodeInfo.kernelVersion}' 2>/dev/null || true)
runtime=$(kubectl get node "$node" -o jsonpath='{.status.nodeInfo.containerRuntimeVersion}' 2>/dev/null || true)
guest_kernel=$(head -n1 <<<"$logs")
exit_code=$(kubectl get pod -n "$ns" "$pod" -o jsonpath='{.status.containerStatuses[0].state.terminated.exitCode}' 2>/dev/null || true)

echo "----- kernels -----"
echo "node  $node ($runtime): ${node_kernel:-unknown}"
echo "guest (uname -r in the pod):            ${guest_kernel:-unknown}"

[[ "$phase" == Succeeded && "$exit_code" == 0 ]] ||
  die "pod ended with phase $phase, exit code ${exit_code:-?}: the sandbox image did not run on the Kata pool"
[[ -n "$guest_kernel" && -n "$node_kernel" ]] || die "could not read both kernel versions; not proven"
if [[ "$guest_kernel" == "$node_kernel" ]]; then
  die "guest kernel equals the node kernel ($node_kernel): the pod ran under runc, not in a Kata VM. Do NOT enable PoC runs on this pool; see ADR 0004 (ACI fallback)"
fi
log "OK: the sandbox image ran in a Kata VM on $node (guest $guest_kernel, node $node_kernel)"
