#!/usr/bin/env bash
# Tear down what infra/up.sh created (ADR 0002 §6), in reverse order.
#
#   infra/down.sh --subscription <id> (--envs test,staging,prod | --all)
#                 [--keep-github] [--yes] [--yes-really-destroy-prod] [--dry-run]
#
#   --subscription  target subscription GUID (required)
#   --envs          envs whose compute + data stacks are destroyed
#   --all           every env, then the global stack, the GitHub repo
#                   variables/Environments, the Cloudflare NS records (if
#                   CLOUDFLARE_API_TOKEN is set) and finally bootstrap
#                   (state account, RGs, identities, DNS zones)
#   --keep-github   with --all: leave the GitHub variables/Environments alone
#   --yes           skip the typed subscription-name confirmation (destroys
#                   without asking!), except for prod: see below
#   --yes-really-destroy-prod
#                   with --yes: also skip typing `prod`. Without it, destroying
#                   prod (--envs ...prod... or --all) always asks you to type
#                   `prod`, and fails when there is no terminal to ask on
#   --dry-run       print what would be destroyed/deleted, change nothing
#
# Order: per env (test, staging, prod — prod last) compute, then data; then
# with --all: global, Cloudflare NS, GitHub, bootstrap (its state is pulled
# back to local first, because it lives in the account being deleted).
# Afterwards the soft-deleted Key Vaults of the envs destroyed in this run
# (kv-bbm-<tst|stg|prd>-<suffix>, plus kv-bbm-shared-<suffix> with --all) are
# purged so the names can be reused at once; other soft-deleted vaults are
# left alone.
#
# With --all, after a successful teardown the per-tenant tfvars/backend fields
# up.sh wrote (subscription_id, suffix, admin/power-operator/Key Vault officer
# object ids, the global hint block's principal ids, backend state account)
# are reset to their placeholders, so up.sh on another tenant starts clean.
# dns_zone_name, alert_emails, github_reviewer_ids and github_repo are kept.
# --envs alone changes no files. Re-running after a failure continues where it
# stopped.
set -euo pipefail

export BBM_LOG_PREFIX=down
# shellcheck source-path=SCRIPTDIR source=lib/common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

usage() {
  awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "${BASH_SOURCE[0]}"
  exit "${1:-2}"
}

SUB="" ENVS_ARG="" ALL=0 KEEP_GH=0 REALLY_PROD=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --subscription) SUB=${2:?--subscription needs a value}; shift 2 ;;
    --subscription=*) SUB=${1#*=}; shift ;;
    --envs) ENVS_ARG=${2:?--envs needs a value}; shift 2 ;;
    --envs=*) ENVS_ARG=${1#*=}; shift ;;
    --all) ALL=1; shift ;;
    --keep-github) KEEP_GH=1; shift ;;
    --yes | -y) ASSUME_YES=1; shift ;;
    --yes-really-destroy-prod) REALLY_PROD=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h | --help) usage 0 ;;
    *) echo "down.sh: unknown argument '$1'" >&2; usage 2 ;;
  esac
done
[[ -n "$SUB" ]] || { echo "down.sh: --subscription is required" >&2; usage 2; }
[[ -n "$ENVS_ARG" || $ALL == 1 ]] || { echo "down.sh: pass --envs <list> or --all" >&2; usage 2; }
SUB=$(lower "$SUB")
is_guid "$SUB" || die "--subscription must be a subscription GUID (got '$SUB')"
[[ $ALL == 1 ]] && ENVS_ARG="test,staging,prod"
IFS=, read -r -a _req <<<"$ENVS_ARG"
for e in ${_req[@]+"${_req[@]}"}; do
  case "$e" in test | staging | prod | "") ;; *) die "--envs: unknown env '$e' (test, staging, prod)" ;; esac
done
ENVS=()
for e in test staging prod; do [[ ",$ENVS_ARG," == *",$e,"* ]] && ENVS+=("$e"); done
[[ ${#ENVS[@]} -gt 0 ]] || die "no environments selected (--envs test,staging,prod)"

ENVS_DIR="$BBM_TF_ROOT/envs"
BOOT_VARS="$ENVS_DIR/global/bootstrap.tfvars"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/bbm-down.XXXXXX")
chmod 700 "$WORK"
trap 'rm -rf "$WORK"' EXIT
[[ "$DRY_RUN" == 1 ]] && warn "dry run: nothing is destroyed or deleted"

# ---- 1. preflight -----------------------------------------------------------
step 1 "Preflight"

need=(az terraform jq curl awk)
[[ $ALL == 1 && $KEEP_GH == 0 ]] && need+=(gh)
missing=()
for t in "${need[@]}"; do have "$t" || missing+=("$t"); done
[[ ${#missing[@]} -eq 0 ]] || die "missing tools: ${missing[*]}"

if ! az account show -o none 2>/dev/null; then
  info "Not logged in to Azure. Run: az login --use-device-code   then re-run."
  exit 1
fi
az account set --subscription "$SUB" || die "cannot select subscription $SUB"
SUB_NAME=$(az account show --query name -o tsv)
REPO=$(tfvars_get_string "$BOOT_VARS" github_repo)
LOC_ABBR=$(tfvars_get_string "$BOOT_VARS" location_abbr)
ZONE=$(tfvars_get_string "$BOOT_VARS" dns_zone_name)

export TFSTATE_RG="${TFSTATE_RG:-rg-bbm-tfstate-$LOC_ABBR}"
if [[ -z "${TFSTATE_ACCOUNT:-}" ]]; then
  TFSTATE_ACCOUNT=$(az storage account list -g "$TFSTATE_RG" \
    --query "[?starts_with(name, 'stbbmtfstate')].name | [0]" -o tsv 2>/dev/null || true)
fi
export TFSTATE_ACCOUNT
if [[ -z "$TFSTATE_ACCOUNT" ]]; then
  bootstrap_local_state_has_resources ||
    die "no state account in $TFSTATE_RG of subscription $SUB_NAME: nothing to tear down (or set TFSTATE_ACCOUNT)"
fi
info "subscription $SUB_NAME ($SUB); state ${TFSTATE_ACCOUNT:-<local bootstrap state only>} in $TFSTATE_RG"

# ---- 2. confirm -------------------------------------------------------------
step 2 "Confirm"

info "will destroy, in order:"
for e in "${ENVS[@]}"; do info "  compute + data stacks of '$e' (cluster, database, Key Vault, storage, DNS records)"; done
if [[ $ALL == 1 ]]; then
  info "  global stack (ACR with all images, shared Log Analytics, shared Key Vault)"
  [[ -n "${CLOUDFLARE_API_TOKEN:-}" && -n "$ZONE" ]] && info "  Cloudflare NS records for $ZONE"
  [[ $KEEP_GH == 0 ]] && info "  GitHub repo variables and Environments of $REPO created by gh_setup_commands"
  info "  bootstrap stack (state account, every bbm resource group, OIDC apps, DNS zones${ZONE:+ for $ZONE})"
fi
if [[ $ALL == 1 ]]; then
  info "  then purge the soft-deleted Key Vaults of those envs and the shared vault"
else
  info "  then purge the soft-deleted Key Vaults of those envs (no others)"
fi
[[ $ALL == 1 ]] && info "  finally reset the per-tenant fields in infra/terraform/envs/** to placeholders"
if [[ "$DRY_RUN" == 0 && "$ASSUME_YES" == 0 ]]; then
  _tty_ok || die "no terminal for the confirmation: pass --yes"
  printf 'Type the subscription name (%s) to confirm: ' "$SUB_NAME" >/dev/tty
  IFS= read -r typed </dev/tty || typed=""
  [[ "$typed" == "$SUB_NAME" ]] || die "confirmation did not match; nothing destroyed"
fi
# prod gets its own typed confirmation, which plain --yes does not skip.
HAS_PROD=0
for e in "${ENVS[@]}"; do [[ "$e" == prod ]] && HAS_PROD=1; done
if [[ $HAS_PROD == 1 ]]; then
  warn "prod is selected: its cluster, database (all data) and Key Vault are destroyed"
  if [[ "$ASSUME_YES" == 1 && $REALLY_PROD == 1 ]]; then
    info "prod confirmation skipped (--yes --yes-really-destroy-prod)"
  elif [[ "$DRY_RUN" == 1 ]]; then
    info "dry run: a real run asks you to type 'prod' (or needs --yes --yes-really-destroy-prod)"
  else
    _tty_ok || die "destroying prod needs you to type 'prod', and there is no terminal: pass --yes --yes-really-destroy-prod to skip it; nothing destroyed"
    printf "Type 'prod' to confirm destroying prod: " >/dev/tty
    IFS= read -r typed </dev/tty || typed=""
    [[ "$typed" == prod ]] || die "prod confirmation did not match; nothing destroyed"
  fi
fi
ASSUME_YES=1 # confirmed; the per-stack plans run unattended

# Capture bootstrap outputs needed after bootstrap is gone.
GH_SCRIPT="$WORK/gh-setup.sh"
if [[ $ALL == 1 ]]; then
  if [[ -n "$TFSTATE_ACCOUNT" ]]; then
    bootstrap_use_remote_backend
    retry 3 20 run "$TF_SH" bootstrap global init -reconfigure || die "bootstrap init failed"
  fi
  "$TF_SH" bootstrap global output -raw gh_setup_commands >"$GH_SCRIPT" 2>/dev/null || : >"$GH_SCRIPT"
fi

# ---- 3. envs ----------------------------------------------------------------
step 3 "Environments: ${ENVS[*]}"

# Key Vaults to purge after the destroy: only the vaults of the stacks this
# run destroys. Read from the stack's output before destroying it; when that
# is unavailable (state gone, dry run), the modules/naming pattern
# kv-bbm-<short>-<suffix> with the suffix from the env's tfvars.
PURGE_VAULTS=()
env_short() { case "$1" in test) echo tst ;; staging) echo stg ;; prod) echo prd ;; global) echo shared ;; esac; }
note_vault() { # note_vault <stack> <env>
  local s=$1 e=$2 out=key_vault_name vars kv="" sfx
  if [[ "$s" == global ]]; then
    out=shared_key_vault_name
    vars="$ENVS_DIR/global/global.tfvars"
  else
    vars="$ENVS_DIR/$e/data.tfvars"
  fi
  if [[ -n "$TFSTATE_ACCOUNT" ]]; then
    kv=$("$TF_SH" "$s" "$e" output -raw "$out" 2>/dev/null) || kv=""
  fi
  if [[ ! "$kv" =~ ^kv-bbm-[a-z0-9-]+$ ]]; then
    sfx=$(tfvars_get_string "$vars" suffix 2>/dev/null || true)
    kv="kv-bbm-$(env_short "$e")-$sfx"
    [[ "$sfx" =~ ^[a-z0-9]{4}$ ]] || {
      warn "$s/$e: no key_vault_name output and no suffix in ${vars#"$BBM_REPO_ROOT/"}; its soft-deleted vault is not purged"
      return 0
    }
  fi
  PURGE_VAULTS+=("$kv")
}

destroy_stack() { # destroy_stack <stack> <env>
  local s=$1 e=$2
  if [[ -z "$TFSTATE_ACCOUNT" ]]; then
    info "$s/$e: no state account; skipping"
    return 0
  fi
  retry 3 20 run "$TF_SH" "$s" "$e" init -reconfigure || die "$s/$e init failed"
  [[ "$s" == data || "$s" == global ]] && note_vault "$s" "$e"
  if [[ "$DRY_RUN" == 0 && -z "$("$TF_SH" "$s" "$e" state list 2>/dev/null)" ]]; then
    info "$s/$e: state is empty; nothing to destroy"
    return 0
  fi
  if ! tf_plan_apply "$s" "$e" --destroy; then
    warn "$s/$e destroy failed; retrying once in 60s"
    sleep 60
    tf_plan_apply "$s" "$e" --destroy || die "$s/$e destroy failed; fix and re-run"
  fi
  ok "$s/$e destroyed"
}

for e in "${ENVS[@]}"; do
  destroy_stack compute "$e"
  destroy_stack data "$e"
done

# purge_vaults: purge the soft-deleted vaults named in PURGE_VAULTS (other
# soft-deleted kv-bbm-* vaults, e.g. of envs kept, are left alone).
purge_vaults() {
  local n l want
  info "vaults to purge if soft-deleted: ${PURGE_VAULTS[*]:-none}"
  [[ ${#PURGE_VAULTS[@]} -gt 0 ]] || return 0
  while read -r n l; do
    [[ -n "$n" ]] || continue
    for want in "${PURGE_VAULTS[@]}"; do
      [[ "$n" == "$want" ]] || continue
      run az keyvault purge -n "$n" -l "$l" || warn "could not purge $n (purge protection?); the name stays reserved until it expires"
    done
  done < <(az keyvault list-deleted --resource-type vault \
    --query "[?starts_with(name, 'kv-bbm-')].[name, properties.location]" -o tsv 2>/dev/null || true)
}

if [[ $ALL == 0 ]]; then
  step 4 "Purge soft-deleted Key Vaults"
  purge_vaults
  ok "done. ${ENVS[*]} destroyed; global and bootstrap untouched."
  info "To bring them back: infra/up.sh --subscription $SUB --envs $(
    IFS=,
    echo "${ENVS[*]}"
  )"
  exit 0
fi

# ---- 4. global --------------------------------------------------------------
step 4 "Global stack"
destroy_stack global global

# ---- 5. Cloudflare ----------------------------------------------------------
step 5 "Cloudflare NS records"
if [[ -z "$ZONE" ]]; then
  info "no dns_zone_name; skipping"
elif [[ -n "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  cf_remove_azure_ns "$ZONE"
else
  info "CLOUDFLARE_API_TOKEN not set: remove the NS records for $ZONE at your DNS host by hand"
fi

# ---- 6. GitHub --------------------------------------------------------------
step 6 "GitHub repo variables and Environments"
if [[ $KEEP_GH == 1 ]]; then
  info "skipped (--keep-github)"
else
  gh_vars=() gh_envs=()
  if [[ -s "$GH_SCRIPT" ]]; then
    src="gh_setup_commands"
    while IFS= read -r v; do gh_vars+=("$v"); done < <(
      awk '$1 == "gh" && $2 == "variable" && $3 == "set" && $0 !~ / --env / { print $4 }' "$GH_SCRIPT" | sort -u
    )
    while IFS= read -r v; do gh_envs+=("$v"); done < <(
      grep -oE "repos/[^ ]+/environments/[A-Za-z0-9_.-]+ --input" "$GH_SCRIPT" |
        sed -E 's#.*/environments/##; s/ --input$//' | sort -u
    )
  else
    # Bootstrap output unavailable (already destroyed?): fall back to github.tf.
    src="stacks/bootstrap/github.tf"
    gtf="$BOOTSTRAP_DIR/github.tf"
    while IFS= read -r v; do gh_vars+=("$v"); done < <(
      awk '/repo_variables[ \t]*=[ \t]*\{/ { on = 1; next } on && /^[ \t]*\}/ { exit }
           on && match($0, /^[ \t]*[A-Z_]+[ \t]*=/) { k = $1; print k }' "$gtf" | sort -u
    )
    while IFS= read -r v; do gh_envs+=("$v"); done < <(
      awk '/github_environments[ \t]*=[ \t]*\{/ { on = 1; next } on && /^[ \t]*\}/ { exit }
           on && match($0, /^[ \t]*"[A-Za-z0-9_.-]+"[ \t]*=/) { k = $1; gsub(/"/, "", k); print k }' "$gtf" | sort -u
    )
  fi
  info "from $src: repo variables: ${gh_vars[*]:-none}"
  info "from $src: environments (with their AZURE_CLIENT_ID): ${gh_envs[*]:-none}"
  for v in ${gh_vars[@]+"${gh_vars[@]}"}; do
    run gh variable delete "$v" --repo "$REPO" || warn "could not delete variable $v (already gone?)"
  done
  for v in ${gh_envs[@]+"${gh_envs[@]}"}; do
    run gh api -X DELETE "repos/$REPO/environments/$v" || warn "could not delete environment $v (already gone?)"
  done
fi

# ---- 7. bootstrap -----------------------------------------------------------
step 7 "Bootstrap stack (local state)"

local_state="$BOOTSTRAP_DIR/terraform.tfstate"
if bootstrap_local_state_has_resources; then
  info "using existing local bootstrap state (a previous run already pulled it)"
elif [[ -n "$TFSTATE_ACCOUNT" ]]; then
  if [[ "$DRY_RUN" == 1 ]]; then
    run "$TF_SH" bootstrap global state pull ">" "$local_state"
  else
    "$TF_SH" bootstrap global state pull >"$WORK/bootstrap.tfstate" || die "could not pull bootstrap state"
    [[ "$(jq '.resources | length' "$WORK/bootstrap.tfstate")" -gt 0 ]] || die "pulled bootstrap state is empty"
    cp "$WORK/bootstrap.tfstate" "$local_state"
    cp "$WORK/bootstrap.tfstate" "$BOOTSTRAP_DIR/terraform.tfstate.pulled-$(date -u +%Y%m%dT%H%M%SZ)"
    ok "pulled bootstrap state to ${local_state#"$BBM_REPO_ROOT/"}"
  fi
else
  info "no state account and no local bootstrap state: nothing to destroy"
fi
if [[ "$DRY_RUN" == 1 ]] || bootstrap_local_state_has_resources; then
  bootstrap_use_local_backend
  bootstrap_init_local
  tf_plan_apply bootstrap global --destroy || die "bootstrap destroy failed; re-run (the local state is kept)"
  _remove_override
  if [[ "$DRY_RUN" == 0 ]]; then
    mv "$local_state" "$BOOTSTRAP_DIR/terraform.tfstate.destroyed-$(date -u +%Y%m%dT%H%M%SZ)"
    rm -f "$BOOTSTRAP_DIR/terraform.tfstate.backup"
  fi
  ok "bootstrap destroyed"
fi

# ---- 8. Key Vaults ----------------------------------------------------------
step 8 "Purge soft-deleted Key Vaults"
purge_vaults

# ---- 9. tfvars --------------------------------------------------------------
step 9 "Reset per-tenant tfvars fields"
reset_tenant_fields

cat >&2 <<EOF

Done. The per-tenant fields above were reset to placeholders ($PLACEHOLDER_GUID / "$PLACEHOLDER_SUFFIX" /
stbbmtfstate$PLACEHOLDER_SUFFIX); commit them. Kept: dns_zone_name, alert_emails, github_reviewer_ids, github_repo.
  - Deleted Entra app registrations sit in the recycle bin for 30 days (only matters for reusing names at once).
  - stacks/bootstrap/terraform.tfstate.* backups (gitignored) can be deleted.
EOF
[[ "$DRY_RUN" == 1 ]] && warn "dry run: nothing was changed"
ok "done"
