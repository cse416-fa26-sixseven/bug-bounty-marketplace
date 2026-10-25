#!/usr/bin/env bash
# One-command, idempotent bring-up of the whole Azure footprint (ADR 0002 §6).
#
#   infra/up.sh --subscription <id> [--zone <zone>] [--envs test,staging]
#               [--prod] [--skip-github] [--yes] [--dry-run]
#
#   --subscription  target subscription GUID (required)
#   --zone          DNS zone, e.g. bbm.example.com (default: dns_zone_name in
#                   envs/global/bootstrap.tfvars, else an interactive prompt)
#   --envs          comma-separated envs to bring up (default: test,staging)
#   --prod          also bring up prod (same as listing it in --envs)
#   --skip-github   do not run the generated gh setup script (repo vars + envs)
#   --yes           no confirmations; accept defaults; keep going when the
#                   DNS delegation has not propagated yet; reset the old
#                   tenant's tfvars fields on a subscription mismatch
#   --dry-run       print mutating commands and file edits instead of running
#                   them (read-only az/gh/terraform-output queries still run)
#
# Log in first:  az login --use-device-code   (add --tenant <id> if needed)
#
# Steps (each idempotent; a failed run is resumed by running it again):
#    1 preflight            tools, az login, subscription, your object id, github_repo
#                           (from gh repo view), gh admin, tenant-switch check
#    2 DNS zone             --zone / bootstrap.tfvars / prompt
#    3 bootstrap.tfvars     subscription, admin ids, providers, alert email, reviewers
#    4 quota and versions   BASv2/regional vCPU, PG B1ms, AKS GA minor (warnings)
#    5 bootstrap            apply on local state, migrate it into the state account
#    6 tfvars               suffix/subscription everywhere, global hint block, KV officers
#    7 GitHub               run the generated gh_setup_commands (unless --skip-github)
#    8 DNS delegation       print NS; upsert in Cloudflare if CLOUDFLARE_API_TOKEN is set
#    9 global               apply; mirror postgres/curl images into ACR
#   10 per env              data, llm-api-key placeholder, compute, platform install
#   11 summary              URLs, next steps, tfvars to commit
#
# Environment (optional):
#   CLOUDFLARE_API_TOKEN  Zone:Read + DNS:Edit on the parent domain (never stored)
#   BBM_DNS_TIMEOUT       seconds to wait for public NS delegation (900)
#   BBM_DNS_POLL          seconds between DNS polls (20)
#   BBM_ALLOW_ANY_TERRAFORM=1  skip the Terraform 1.9.x check
set -euo pipefail

export BBM_LOG_PREFIX=up
# shellcheck source-path=SCRIPTDIR source=lib/common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

usage() {
  awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "${BASH_SOURCE[0]}"
  exit "${1:-2}"
}

# ---- args -------------------------------------------------------------------

SUB="" ZONE="" ENVS_ARG="test,staging" WITH_PROD=0 SKIP_GH=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --subscription) SUB=${2:?--subscription needs a value}; shift 2 ;;
    --subscription=*) SUB=${1#*=}; shift ;;
    --zone) ZONE=${2:?--zone needs a value}; shift 2 ;;
    --zone=*) ZONE=${1#*=}; shift ;;
    --envs) ENVS_ARG=${2:?--envs needs a value}; shift 2 ;;
    --envs=*) ENVS_ARG=${1#*=}; shift ;;
    --prod) WITH_PROD=1; shift ;;
    --skip-github) SKIP_GH=1; shift ;;
    --yes | -y) ASSUME_YES=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h | --help) usage 0 ;;
    *) echo "up.sh: unknown argument '$1'" >&2; usage 2 ;;
  esac
done
[[ -n "$SUB" ]] || { echo "up.sh: --subscription is required" >&2; usage 2; }
SUB=$(lower "$SUB")
is_guid "$SUB" || die "--subscription must be a subscription GUID (got '$SUB')"

ENVS=()
for e in test staging prod; do
  if [[ ",$ENVS_ARG," == *",$e,"* ]] || [[ "$e" == prod && $WITH_PROD == 1 ]]; then ENVS+=("$e"); fi
done
IFS=, read -r -a _req <<<"$ENVS_ARG"
for e in ${_req[@]+"${_req[@]}"}; do
  case "$e" in test | staging | prod | "") ;; *) die "--envs: unknown env '$e' (test, staging, prod)" ;; esac
done

[[ ${#ENVS[@]} -gt 0 ]] || die "no environments selected (--envs test,staging[,prod])"

ENVS_DIR="$BBM_TF_ROOT/envs"
BOOT_VARS="$ENVS_DIR/global/bootstrap.tfvars"
GLOBAL_VARS="$ENVS_DIR/global/global.tfvars"

WORK=$(mktemp -d "${TMPDIR:-/tmp}/bbm-up.XXXXXX")
chmod 700 "$WORK"
trap 'rm -rf "$WORK"' EXIT

[[ "$DRY_RUN" == 1 ]] && warn "dry run: nothing is created, applied or written"

# ---- 1. preflight -----------------------------------------------------------
step 1 "Preflight"

need=(az terraform jq curl kubectl kubelogin helm awk)
[[ $SKIP_GH == 1 ]] || need+=(gh)
missing=()
for t in "${need[@]}"; do have "$t" || missing+=("$t"); done
[[ ${#missing[@]} -eq 0 ]] || die "missing tools: ${missing[*]}"
have dig || have nslookup || info "dig/nslookup not found; DNS checks use DNS-over-HTTPS via curl"

tfv=$(terraform version -json 2>/dev/null | jq -r .terraform_version)
if [[ "$tfv" != 1.9.* && "${BBM_ALLOW_ANY_TERRAFORM:-0}" != 1 ]]; then
  die "Terraform $tfv found; use 1.9.x (CI pins 1.9.8; newer versions write state 1.9 cannot read). BBM_ALLOW_ANY_TERRAFORM=1 overrides."
fi

for f in "$BOOT_VARS" "$GLOBAL_VARS"; do [[ -f "$f" ]] || die "missing $f"; done
for e in "${ENVS[@]}"; do
  for f in "$ENVS_DIR/$e/data.tfvars" "$ENVS_DIR/$e/compute.tfvars"; do
    [[ -f "$f" ]] || die "missing $f (env '$e' has no data/compute config yet)"
  done
done
[[ -x "$BBM_REPO_ROOT/deploy/platform/install.sh" ]] ||
  warn "deploy/platform/install.sh not found or not executable; the platform install (step 10) will fail"

if ! az account show -o none 2>/dev/null; then
  echo >&2
  info "Not logged in to Azure. Run:"
  info "    az login --use-device-code"
  info "(add --tenant <tenant-id> if the subscription lives in another tenant), then re-run this script."
  exit 1
fi
az account set --subscription "$SUB" || die "cannot select subscription $SUB (wrong tenant? az login --use-device-code --tenant <id>)"
SUB_NAME=$(az account show --query name -o tsv)
TENANT=$(az account show --query tenantId -o tsv)
AZ_USER=$(az account show --query user.name -o tsv)
ME=$(az ad signed-in-user show --query id -o tsv 2>/dev/null) ||
  die "az ad signed-in-user show failed: log in as a user (not a service principal)"
info "subscription: $SUB_NAME ($SUB), tenant $TENANT"
info "signed in as: $AZ_USER (object id $ME)"
owner=$(az role assignment list --assignee "$ME" --scope "/subscriptions/$SUB" --include-inherited --include-groups \
  --query "[?roleDefinitionName=='Owner'] | length(@)" -o tsv 2>/dev/null || echo "?")
[[ "$owner" != 0 ]] || warn "no Owner role assignment found for you on the subscription; bootstrap/global applies need Owner"

# Account switch: bootstrap.tfvars still filled in for another subscription
# (down.sh --all resets it; an old checkout or a skipped teardown does not).
prev_sub=$(lower "$(tfvars_get_string "$BOOT_VARS" subscription_id)")
if [[ -n "$prev_sub" && "$prev_sub" != "$PLACEHOLDER_GUID" && "$prev_sub" != "$SUB" ]]; then
  warn "envs/global/bootstrap.tfvars is filled in for subscription $prev_sub, not $SUB (account switch?)"
  warn "its object ids, suffix and state account belong to that subscription/tenant; bootstrap would fail with them"
  if confirm "Reset the per-tenant tfvars fields to placeholders first?"; then
    reset_tenant_fields
  else
    die "per-tenant fields not reset: re-run and answer yes (or pass --yes), or run infra/down.sh --all on $prev_sub first"
  fi
fi

# github_repo follows the repo's current owner/name (survives a repo transfer).
REPO=$(tfvars_get_string "$BOOT_VARS" github_repo)
if have gh && gh_repo=$(cd "$BBM_REPO_ROOT" && gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null) &&
  [[ "$gh_repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  if [[ "$gh_repo" != "$REPO" ]]; then
    warn "github_repo in bootstrap.tfvars is $REPO but gh reports $gh_repo (repo transferred?): updating it"
    tfvars_set "$BOOT_VARS" github_repo "$(hcl_quote "$gh_repo")"
    REPO=$gh_repo
  fi
else
  info "gh repo view unavailable; using github_repo = $REPO from bootstrap.tfvars"
fi
LOCATION=$(tfvars_get_string "$BOOT_VARS" location)
LOC_ABBR=$(tfvars_get_string "$BOOT_VARS" location_abbr)
if [[ $SKIP_GH == 0 ]]; then
  gh auth status >/dev/null 2>&1 || die "gh is not logged in: gh auth login (or pass --skip-github)"
  [[ "$(gh api "repos/$REPO" --jq .permissions.admin 2>/dev/null)" == true ]] ||
    die "your gh account is not an admin of $REPO (needed to create Environments); or pass --skip-github"
  ok "gh: admin on $REPO"
fi

# ---- 2. DNS zone ------------------------------------------------------------
step 2 "DNS zone"

cur_zone=$(tfvars_get_string "$BOOT_VARS" dns_zone_name)
if [[ -z "$ZONE" ]]; then ZONE=$cur_zone; fi
while [[ -z "$ZONE" ]] || ! is_zone_name "$(lower "$ZONE")"; do
  [[ -z "$ZONE" ]] || warn "'$ZONE' is not a valid DNS zone name"
  if [[ "$ASSUME_YES" == 1 ]] || ! _tty_ok; then die "no DNS zone: pass --zone <zone> (e.g. bbm.example.com)"; fi
  ZONE=$(ask "DNS zone for this deployment (e.g. bbm.example.com; delegated from its parent domain)")
done
ZONE=$(lower "$ZONE")
[[ -z "$cur_zone" || "$cur_zone" == "$ZONE" ]] ||
  warn "changing dns_zone_name from $cur_zone to $ZONE: the zones are recreated and the old delegation must be removed"
tfvars_set "$BOOT_VARS" dns_zone_name "$(hcl_quote "$ZONE")"

# ---- 3. bootstrap.tfvars ----------------------------------------------------
step 3 "Fill envs/global/bootstrap.tfvars"

tfvars_set "$BOOT_VARS" subscription_id "$(hcl_quote "$SUB")"
tfvars_list_add "$BOOT_VARS" admin_object_ids "$ME"

# Providers bootstrap registers (parsed from its main.tf) ∩ already registered.
boot_providers=$(awk '/resource_providers[ \t]*=[ \t]*toset\(\[/ { on = 1; next } on && /\]/ { exit } on' \
  "$BOOTSTRAP_DIR/main.tf" | grep -oE '"Microsoft\.[A-Za-z]+"' | tr -d '"' | sort -u)
[[ -n "$boot_providers" ]] || die "could not parse local.resource_providers from stacks/bootstrap/main.tf"
registered=$(az provider list --query "[?registrationState=='Registered'].namespace" -o tsv | sort -u)
prereg=()
while IFS= read -r p; do [[ -n "$p" ]] && prereg+=("$p"); done < <(comm -12 <(echo "$boot_providers") <(echo "$registered"))
tfvars_set "$BOOT_VARS" preregistered_resource_providers "$(hcl_list ${prereg[@]+"${prereg[@]}"})"

emails=$(tfvars_get "$BOOT_VARS" alert_emails)
if [[ "$emails" == *example.com* || "$emails" == "[]" ]]; then
  def=""
  is_email "$AZ_USER" && def=$AZ_USER
  em=$(ask "Budget alert email" "$def")
  is_email "$em" || die "'$em' is not an email address"
  tfvars_set "$BOOT_VARS" alert_emails "$(hcl_list "$em")"
  tfvars_set_if_present "$GLOBAL_VARS" alert_emails "$(hcl_list "$em")"
fi

if [[ "$(tfvars_get "$BOOT_VARS" github_reviewer_ids)" == "[]" ]]; then
  gid=""
  if [[ $SKIP_GH == 0 ]]; then gid=$(gh api user --jq .id 2>/dev/null || true); fi
  if [[ -z "$gid" ]] && { [[ "$ASSUME_YES" == 1 ]] || ! _tty_ok; }; then
    warn "github_reviewer_ids left empty: add a required reviewer to infra-global, prod and contracts-sepolia in the GitHub UI"
  else
    rid=$(ask "Numeric GitHub user id(s) of the required reviewer(s), comma-separated" "$gid")
    [[ "$rid" =~ ^[0-9]+(,[0-9]+)*$ ]] || die "reviewer ids must be numbers (gh api users/<login> --jq .id)"
    IFS=, read -r -a rids <<<"$rid"
    tfvars_set "$BOOT_VARS" github_reviewer_ids "$(hcl_list --raw "${rids[@]}")"
  fi
fi

# ---- 4. quota / SKU / versions (warnings only) ------------------------------
step 4 "Quota, SKUs and AKS versions in $LOCATION"

usage_json=$(az vm list-usage -l "$LOCATION" -o json 2>/dev/null || echo '[]')
need_vcpu=$((2 * ${#ENVS[@]}))
for fam in cores standardBASv2Family; do
  read -r cur lim < <(echo "$usage_json" | jq -r --arg n "$fam" \
    '(.[] | select(.name.value == $n) | "\(.currentValue) \(.limit)") // "? ?"' | head -n1) || true
  info "vCPU $fam: ${cur:-?} used of ${lim:-?} (this run needs about $need_vcpu for system nodes)"
  if [[ "${lim:-?}" =~ ^[0-9]+$ && "${cur:-?}" =~ ^[0-9]+$ ]] && ((lim - cur < need_vcpu)); then
    warn "$fam has only $((lim - cur)) vCPUs free: request more under Portal → Quotas → Compute ($LOCATION)"
  fi
done

if az postgres flexible-server list-skus -l "$LOCATION" -o json 2>/dev/null |
  jq -e '[.[].supportedServerEditions[]? | select(.name == "Burstable") | .supportedServerSkus[]?.name] | index("Standard_B1ms")' >/dev/null; then
  ok "PostgreSQL Flexible Standard_B1ms is offered in $LOCATION"
else
  warn "PostgreSQL Flexible Standard_B1ms not offered in $LOCATION for this subscription (see azure-bootstrap.md §4)"
fi

aks_json=$(az aks get-versions -l "$LOCATION" -o json 2>/dev/null || echo '{}')
ga=$(echo "$aks_json" | jq -r '.values[]? | select(.isPreview != true) | .version' | sort -t. -k1,1n -k2,2n -u)
aks_default=$(echo "$aks_json" | jq -r '[.values[]? | select(.isPreview != true and .isDefault == true) | .version][0] // empty')
[[ -n "$aks_default" ]] || aks_default=$(echo "$ga" | tail -n1)
if [[ -z "$ga" ]]; then
  warn "could not list AKS versions in $LOCATION; leaving kubernetes_version as committed"
else
  info "AKS GA minors in $LOCATION: $(echo "$ga" | tr '\n' ' ')(default $aks_default)"
  for e in test staging prod; do
    f="$ENVS_DIR/$e/compute.tfvars"
    [[ -f "$f" ]] || continue
    kv=$(tfvars_get_string "$f" kubernetes_version)
    if ! echo "$ga" | grep -qxF "$kv"; then
      warn "envs/$e/compute.tfvars: kubernetes_version $kv is not offered; using $aks_default"
      tfvars_set "$f" kubernetes_version "$(hcl_quote "$aks_default")"
    fi
  done
fi

# ---- 5. bootstrap -----------------------------------------------------------
step 5 "Bootstrap stack (state account, RGs, identities, DNS zones)"

export TFSTATE_RG="rg-bbm-tfstate-$LOC_ABBR"
acct=""
if az group exists -n "$TFSTATE_RG" -o tsv 2>/dev/null | grep -qx true; then
  acct=$(az storage account list -g "$TFSTATE_RG" --query "[?starts_with(name, 'stbbmtfstate')].name | [0]" -o tsv 2>/dev/null || true)
fi

first_of_month=$(date -u +%Y-%m-01T00:00:00Z)
bump_budget_start() { # bump_budget_start <file>: only before the budget exists
  local f=$1 v
  tfvars_has "$f" budget_start_date || return 0
  v=$(tfvars_get_string "$f" budget_start_date)
  [[ "$v" < "$first_of_month" ]] && tfvars_set "$f" budget_start_date "$(hcl_quote "$first_of_month")"
  return 0
}

migrate_bootstrap() {
  info "migrating bootstrap state into $TFSTATE_ACCOUNT"
  bootstrap_use_remote_backend
  retry 10 30 run "$TF_SH" bootstrap global init -migrate-state -force-copy ||
    die "state migration failed (403? wait a few minutes for the blob role to propagate, then re-run)"
  if [[ "$DRY_RUN" == 0 ]]; then
    n=$("$TF_SH" bootstrap global state list | wc -l | tr -d ' ')
    [[ "$n" -gt 0 ]] || die "remote bootstrap state is empty after migration; local state kept in $BOOTSTRAP_DIR"
    bak="$BOOTSTRAP_DIR/terraform.tfstate.migrated-$(date -u +%Y%m%dT%H%M%SZ)"
    mv "$BOOTSTRAP_DIR/terraform.tfstate" "$bak"
    rm -f "$BOOTSTRAP_DIR/terraform.tfstate.backup"
    ok "bootstrap state migrated ($n resources); local copy moved to ${bak#"$BBM_REPO_ROOT/"} (gitignored; delete when happy)"
  fi
}

if bootstrap_local_state_has_resources; then
  info "found local bootstrap state (a previous run stopped before migrating): re-applying locally"
  bootstrap_use_local_backend
  bootstrap_init_local
  tf_plan_apply bootstrap global
  export TFSTATE_ACCOUNT
  TFSTATE_ACCOUNT=$(tf_out bootstrap global tfstate_storage_account)
  migrate_bootstrap
elif [[ -n "$acct" ]]; then
  export TFSTATE_ACCOUNT=$acct
  info "state account $acct exists: bootstrap is on remote state"
  exists=$(az storage blob exists --account-name "$acct" --container-name tfstate --name bootstrap.tfstate \
    --auth-mode login --query exists -o tsv 2>/dev/null || echo error)
  case "$exists" in
    true) ;;
    false) die "$acct exists but has no bootstrap.tfstate: restore it (blob versions/soft delete) before re-running" ;;
    *) die "cannot read $acct/tfstate (need Storage Blob Data Contributor; you are added via admin_object_ids)" ;;
  esac
  bootstrap_use_remote_backend
  retry 5 30 run "$TF_SH" bootstrap global init -reconfigure || die "bootstrap init failed"
  tf_plan_apply bootstrap global
else
  info "no state account in $TFSTATE_RG: first bootstrap, on local state"
  bump_budget_start "$BOOT_VARS"
  bootstrap_use_local_backend
  bootstrap_init_local
  tf_plan_apply bootstrap global
  export TFSTATE_ACCOUNT
  TFSTATE_ACCOUNT=$(tf_out bootstrap global tfstate_storage_account)
  migrate_bootstrap
fi
TFSTATE_RG=$(tf_out bootstrap global tfstate_resource_group)
TFSTATE_ACCOUNT=$(tf_out bootstrap global tfstate_storage_account)
SUFFIX=$(tf_out bootstrap global suffix)
info "TFSTATE_RG=$TFSTATE_RG TFSTATE_ACCOUNT=$TFSTATE_ACCOUNT suffix=$SUFFIX"

# ---- 6. tfvars --------------------------------------------------------------
step 6 "Write suffix, subscription and Key Vault officers into envs/**"

tf_out bootstrap global global_tfvars_hint >"$WORK/hint.tfvars"
tfvars_replace_block "$GLOBAL_VARS" "$WORK/hint.tfvars"
[[ "$DRY_RUN" == 1 ]] || tfvars_check_dupes "$GLOBAL_VARS"

while IFS= read -r f; do
  tfvars_set_if_present "$f" subscription_id "$(hcl_quote "$SUB")"
  tfvars_set_if_present "$f" suffix "$(hcl_quote "$SUFFIX")"
done < <(find "$ENVS_DIR" -name '*.tfvars' | sort)
while IFS= read -r f; do
  tfvars_set_if_present "$f" resource_group_name "$(hcl_quote "$TFSTATE_RG")"
  tfvars_set_if_present "$f" storage_account_name "$(hcl_quote "$TFSTATE_ACCOUNT")"
done < <(find "$ENVS_DIR" -name 'backend*.hcl' | sort)

tfvars_list_add "$GLOBAL_VARS" secret_officer_user_object_ids "$ME"
for e in "${ENVS[@]}"; do
  tfvars_list_add "$ENVS_DIR/$e/data.tfvars" secret_officer_user_object_ids "$ME"
done
tf_fmt -recursive "$ENVS_DIR"

# ---- 7. GitHub --------------------------------------------------------------
step 7 "GitHub repo variables and Environments"

if [[ $SKIP_GH == 1 ]]; then
  info "skipped (--skip-github). Later: infra/terraform/scripts/tf.sh bootstrap global output -raw gh_setup_commands | bash"
else
  gh_script="$WORK/gh-setup.sh"
  tf_out bootstrap global gh_setup_commands >"$gh_script"
  info "gh setup script: $(grep -c '^gh variable set [A-Z_]* --repo [^ ]* --body' "$gh_script" || true) repo variables, environments: $(grep -oE 'environments/[a-z-]+ --input' "$gh_script" | sed -E 's#environments/##; s/ --input//' | tr '\n' ' ')"
  if [[ "$DRY_RUN" == 1 ]]; then
    run bash "$gh_script"
  elif confirm "Run it against $REPO now? (review: $gh_script)"; then
    run bash "$gh_script"
  else
    die "GitHub setup not run (pass --yes, or --skip-github and run it later)"
  fi
fi

# ---- 8. DNS delegation ------------------------------------------------------
step 8 "DNS delegation for $ZONE"

NS=()
while IFS= read -r n; do [[ -n "$n" ]] && NS+=("$n"); done < <(
  tf_out_json bootstrap global dns_name_servers | jq -r '.[]? // empty' | norm_ns
)
if [[ ${#NS[@]} -eq 0 ]]; then
  [[ "$DRY_RUN" == 1 ]] || die "bootstrap output dns_name_servers is empty"
  NS=("<ns1>" "<ns2>" "<ns3>" "<ns4>")
fi
info "Add these records at the DNS host of the parent domain:"
printf '    %-40s %-4s %s\n' "NAME" "TYPE" "VALUE" >&2
for n in "${NS[@]}"; do printf '    %-40s %-4s %s\n' "$ZONE" NS "$n." >&2; done

if [[ -n "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  cf_sync_ns "$ZONE" "${NS[@]}"
else
  info "CLOUDFLARE_API_TOKEN not set: add the records by hand. The script waits for them before the platform install."
fi

# ---- 9. global --------------------------------------------------------------
step 9 "Global stack (ACR, shared Log Analytics, shared Key Vault) and image mirrors"

retry 5 30 run "$TF_SH" global global init -reconfigure || die "global init failed"
if [[ "$DRY_RUN" == 1 ]] || [[ -z "$("$TF_SH" global global state list 2>/dev/null)" ]]; then
  bump_budget_start "$GLOBAL_VARS"
fi
tf_plan_apply global global

ACR=$(tf_out global global acr_name)
mirror() { # mirror <source> <repository> <tag>
  if az acr repository show-tags -n "$ACR" --repository "$2" -o tsv 2>/dev/null | grep -qxF "$3"; then
    info "ACR $ACR: $2:$3 already mirrored"
  else
    run az acr import -n "$ACR" --source "$1" --image "$2:$3"
  fi
}
mirror docker.io/library/postgres:16-alpine mirror/postgres 16-alpine
mirror docker.io/curlimages/curl:8.10.1 mirror/curl 8.10.1

# ---- 10. per env ------------------------------------------------------------
step 10 "Environments: ${ENVS[*]}"

ensure_llm_key() { # ensure_llm_key <vault>
  local kv=$1 out i
  [[ "$DRY_RUN" == 1 ]] && {
    run az keyvault secret set --vault-name "$kv" -n llm-api-key --value placeholder-set-me -o none
    return 0
  }
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if out=$(az keyvault secret show --vault-name "$kv" -n llm-api-key --query name -o tsv 2>&1); then
      info "$kv: llm-api-key already set (left unchanged)"
      return 0
    fi
    if [[ "$out" == *SecretNotFound* || "$out" == *"was not found"* ]]; then
      retry 10 30 run az keyvault secret set --vault-name "$kv" -n llm-api-key --value placeholder-set-me -o none ||
        die "$kv: could not set llm-api-key"
      warn "$kv: llm-api-key set to placeholder-set-me; replace it with the real key later"
      return 0
    fi
    warn "$kv: cannot read llm-api-key yet ($(echo "$out" | head -n1)); retry $i/10 in 30s"
    sleep 30
  done
  die "$kv: no access to secrets (are you in secret_officer_user_object_ids of this env's data.tfvars?)"
}

dns_checked=0
check_delegation() {
  [[ $dns_checked == 1 || "$DRY_RUN" == 1 ]] && return 0
  dns_checked=1
  if wait_for_delegation "$ZONE" "${BBM_DNS_TIMEOUT:-900}" "${NS[@]}"; then return 0; fi
  if [[ "$ASSUME_YES" == 1 ]] || confirm "Delegation of $ZONE is not visible yet. Install the platform anyway (certificates will wait)?"; then
    warn "continuing without delegation: cert-manager retries DNS-01 until the NS records resolve"
    return 0
  fi
  die "delegation of $ZONE not visible at 1.1.1.1; add the NS records above and re-run (completed steps are skipped)"
}

for e in "${ENVS[@]}"; do
  info "---- env $e"
  retry 3 30 run "$TF_SH" data "$e" init -reconfigure || die "data/$e init failed"
  if ! tf_plan_apply data "$e"; then
    warn "data/$e apply failed; retrying once in 60s (Key Vault role assignments propagate slowly)"
    sleep 60
    tf_plan_apply data "$e" || die "data/$e apply failed"
  fi
  ensure_llm_key "$(tf_out data "$e" key_vault_name)"

  retry 3 30 run "$TF_SH" compute "$e" init -reconfigure || die "compute/$e init failed"
  if ! tf_plan_apply compute "$e"; then
    warn "compute/$e apply failed; retrying once in 60s"
    sleep 60
    tf_plan_apply compute "$e" || die "compute/$e apply failed"
  fi

  cluster=$(tf_out compute "$e" cluster_name)
  crg=$(tf_out compute "$e" resource_group_name)
  kubeconfig="$WORK/kubeconfig-$e"
  run az aks get-credentials -g "$crg" -n "$cluster" --file "$kubeconfig" --overwrite-existing
  run kubelogin convert-kubeconfig -l azurecli --kubeconfig "$kubeconfig"
  tf_out compute "$e" helm_values >"$WORK/values-infra-$e.yaml"

  check_delegation
  KUBECONFIG=$kubeconfig run "$BBM_REPO_ROOT/deploy/platform/install.sh" "$e" --values "$WORK/values-infra-$e.yaml" --wait
  ok "env $e is up"
done

# ---- 11. summary ------------------------------------------------------------
step 11 "Summary"

for e in "${ENVS[@]}"; do
  case "$e" in
    test) info "test cluster: CI runs at https://run-<id>-<attempt>.test.$ZONE, PR previews at https://pr-<n>.preview.$ZONE" ;;
    *) info "$e: https://$e.$ZONE  (after the first deploy)" ;;
  esac
done
cat >&2 <<EOF

Next steps:
  - Deploy the app: Actions -> deploy (image_tag=sha-<7> from a green CI run), or env-power <env> up.
  - Pause when idle: Actions -> env-power <env> pause (nightly auto-pause also runs).
  - Replace the llm-api-key placeholder: az keyvault secret set --vault-name <kv> -n llm-api-key --value <key>
  - Shared secrets (sepolia-rpc-url, sepolia-deployer-key): docs/devops/azure-bootstrap.md §12.
  - kubectl: az aks get-credentials -g rg-bbm-<env>-compute-$LOC_ABBR -n aks-bbm-<env>-$LOC_ABBR && kubelogin convert-kubeconfig -l azurecli

Commit the files this script rewrote (they are the source of truth for this subscription):
EOF
git -C "$BBM_REPO_ROOT" status --short -- infra/terraform/envs >&2 || true
[[ "$DRY_RUN" == 1 ]] && warn "dry run: nothing was changed"
ok "done"
