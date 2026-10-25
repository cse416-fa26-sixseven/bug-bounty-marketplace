# shellcheck shell=bash
# Shared helpers for infra/up.sh and infra/down.sh (sourced, not executed).
#
# Portable to bash 3.2 (macOS) and GNU/BSD userlands: no mapfile, no
# associative arrays, no `sed -i`; files are rewritten through a temp file.
#
# Globals the callers may set before using these helpers:
#   DRY_RUN=1    print mutating commands / file edits instead of doing them
#   ASSUME_YES=1 answer "yes" to confirmations, accept prompt defaults
#
# Paths (override for tests):
#   BBM_REPO_ROOT  repo root               (default: two levels above this file)
#   BBM_TF_ROOT    infra/terraform         (default: $BBM_REPO_ROOT/infra/terraform)

: "${DRY_RUN:=0}"
: "${ASSUME_YES:=0}"

BBM_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${BBM_REPO_ROOT:=$(cd "$BBM_LIB_DIR/../.." && pwd)}"
: "${BBM_TF_ROOT:=$BBM_REPO_ROOT/infra/terraform}"
TF_SH="$BBM_TF_ROOT/scripts/tf.sh"

# shellcheck disable=SC2034 # used by up.sh / down.sh / tests
PLACEHOLDER_GUID="00000000-0000-0000-0000-000000000000"
# shellcheck disable=SC2034
PLACEHOLDER_SUFFIX="0000"
HINT_BEGIN="# >>> bootstrap hint (written by infra/up.sh)"
HINT_END="# <<< bootstrap hint"

# ---- logging ----------------------------------------------------------------

if [[ -t 2 && -z "${NO_COLOR:-}" ]]; then
  _c_bold=$'\033[1m' _c_red=$'\033[31m' _c_yel=$'\033[33m' _c_grn=$'\033[32m' _c_dim=$'\033[2m' _c_off=$'\033[0m'
else
  _c_bold="" _c_red="" _c_yel="" _c_grn="" _c_dim="" _c_off=""
fi
: "${BBM_LOG_PREFIX:=bbm}"

step() { # step <n> <title>
  printf '\n%s==> [%s] %s%s\n' "$_c_bold" "$1" "$2" "$_c_off" >&2
}
info() { printf '%s: %s\n' "$BBM_LOG_PREFIX" "$*" >&2; }
ok() { printf '%s: %s%s%s\n' "$BBM_LOG_PREFIX" "$_c_grn" "$*" "$_c_off" >&2; }
warn() { printf '%s: %sWARNING:%s %s\n' "$BBM_LOG_PREFIX" "$_c_yel" "$_c_off" "$*" >&2; }
die() {
  printf '%s: %sERROR:%s %s\n' "$BBM_LOG_PREFIX" "$_c_red" "$_c_off" "$*" >&2
  exit 1
}

# Print a shell-quoted command line.
quote_cmd() {
  local out="" a
  for a in "$@"; do
    out+="$(printf '%q' "$a") "
  done
  printf '%s' "${out% }"
}

# run <cmd...>: echo, then execute (or only echo under DRY_RUN=1).
run() {
  if [[ "$DRY_RUN" == 1 ]]; then
    printf '%s[dry-run]%s %s\n' "$_c_dim" "$_c_off" "$(quote_cmd "$@")" >&2
    return 0
  fi
  printf '%s+ %s%s\n' "$_c_dim" "$(quote_cmd "$@")" "$_c_off" >&2
  "$@"
}

# retry <attempts> <sleep-seconds> <cmd...>: for RBAC propagation (403s).
retry() {
  local n=$1 s=$2 i=1
  shift 2
  while true; do
    if "$@"; then return 0; fi
    if [[ $i -ge $n ]]; then return 1; fi
    warn "attempt $i/$n failed; retrying in ${s}s (role assignments can take minutes to propagate)"
    sleep "$s"
    i=$((i + 1))
  done
}

have() { command -v "$1" >/dev/null 2>&1; }

# ---- prompts ----------------------------------------------------------------

_tty_ok() { [[ -r /dev/tty && -w /dev/tty ]] && { : </dev/tty; } 2>/dev/null; }

# confirm <question>: true on yes. ASSUME_YES=1 → yes. No tty → no.
confirm() {
  [[ "$ASSUME_YES" == 1 ]] && return 0
  _tty_ok || return 1
  local ans
  printf '%s [y/N] ' "$1" >/dev/tty
  IFS= read -r ans </dev/tty || return 1
  [[ "$ans" == y || "$ans" == Y || "$ans" == yes ]]
}

# ask <question> [default]: prints the answer. ASSUME_YES / no tty → default
# (dies if there is none).
ask() {
  local q=$1 def=${2:-} ans
  if [[ "$ASSUME_YES" == 1 ]] || ! _tty_ok; then
    [[ -n "$def" ]] || die "need an answer for: $q (no terminal / --yes, and no default)"
    printf '%s' "$def"
    return 0
  fi
  if [[ -n "$def" ]]; then
    printf '%s [%s]: ' "$q" "$def" >/dev/tty
  else
    printf '%s: ' "$q" >/dev/tty
  fi
  IFS= read -r ans </dev/tty || ans=""
  [[ -n "$ans" ]] || ans=$def
  printf '%s' "$ans"
}

# ---- validation -------------------------------------------------------------

lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

is_guid() {
  [[ "$1" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]
}

# DNS zone: 2+ labels, lowercase letters/digits/hyphens, TLD alphabetic.
is_zone_name() {
  local z=$1
  [[ ${#z} -le 253 ]] || return 1
  [[ "$z" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$ ]]
}

is_email() { [[ "$1" =~ ^[^@[:space:]\"]+@[^@[:space:]\"]+\.[^@[:space:]\"]+$ ]]; }

# ---- tfvars / HCL single-line assignments -----------------------------------
#
# Only single-line `key = value  # optional comment` assignments are edited.
# The key must occur exactly once at top level (any indentation); a value
# that opens a bracket/brace without closing it on the same line is refused.

# _tfvars_awk <mode> <file> <key> [new-value]
#   mode=get: print the value (no comment, trimmed)
#   mode=set: print the whole file with the value replaced
# Exit 3 = key missing, 4 = key repeated, 5 = multi-line value.
_tfvars_awk() {
  awk -v mode="$1" -v key="$3" -v newval="${4:-}" '
    function split_value(rest,    i, c, instr, esc, depth) {
      # rest = text after "="; sets V (value) and C (whitespace + comment)
      instr = 0; esc = 0; depth = 0
      for (i = 1; i <= length(rest); i++) {
        c = substr(rest, i, 1)
        if (instr) {
          if (esc) { esc = 0 } else if (c == "\\") { esc = 1 } else if (c == "\"") { instr = 0 }
          continue
        }
        if (c == "\"") { instr = 1; continue }
        if (c == "[" || c == "{" || c == "(") depth++
        if (c == "]" || c == "}" || c == ")") depth--
        if (c == "#" || (c == "/" && substr(rest, i + 1, 1) == "/")) break
      }
      V = substr(rest, 1, i - 1)
      C = substr(rest, i)
      # move trailing whitespace of the value into the comment part
      match(V, /[ \t]*$/)
      if (RSTART > 0 && RLENGTH > 0) { C = substr(V, RSTART) C; V = substr(V, 1, RSTART - 1) }
      sub(/^[ \t]+/, "", V)
      return depth
    }
    {
      line[NR] = $0
      if (match($0, "^[ \t]*" key "[ \t]*=")) {
        n++
        hit = NR
        pre[NR] = substr($0, 1, RLENGTH)
        rest = substr($0, RLENGTH + 1)
        lead = rest; sub(/[^ \t].*$/, "", lead)
        d = split_value(rest)
        val[NR] = V; com[NR] = C; ws[NR] = lead
        if (d != 0) bad = 1
      }
    }
    END {
      if (n == 0) exit 3
      if (n > 1) exit 4
      if (bad) exit 5
      if (mode == "get") { print val[hit]; exit 0 }
      for (i = 1; i <= NR; i++) {
        if (i == hit) {
          w = ws[i]; if (w == "") w = " "
          c = com[i]
          if (c != "" && c !~ /^[ \t]/) c = " " c
          print pre[i] w newval c
        } else print line[i]
      }
    }
  ' "$2"
}

_tfvars_err() { # _tfvars_err <rc> <file> <key>
  case "$1" in
    3) die "$2: key '$3' not found (expected a single-line '$3 = ...' assignment)" ;;
    4) die "$2: key '$3' is assigned more than once; refusing to guess which to edit" ;;
    5) die "$2: '$3' is not a single-line assignment; edit it by hand or make it one line" ;;
    *) die "$2: failed to parse '$3' (awk exit $1)" ;;
  esac
}

tfvars_has() { # tfvars_has <file> <key>
  [[ -f "$1" ]] && grep -Eq "^[[:space:]]*$2[[:space:]]*=" "$1"
}

tfvars_get() { # tfvars_get <file> <key>  → raw HCL value
  [[ -f "$1" ]] || die "missing file $1"
  local out rc=0
  out=$(_tfvars_awk get "$1" "$2") || rc=$?
  [[ $rc -eq 0 ]] || _tfvars_err "$rc" "$1" "$2"
  printf '%s\n' "$out"
}

# tfvars_get_string <file> <key> → unquoted string value ("" for null)
tfvars_get_string() {
  local v
  v=$(tfvars_get "$1" "$2")
  [[ "$v" == null ]] && v='""'
  v=${v#\"}
  v=${v%\"}
  printf '%s\n' "$v"
}

# _write_file <dest> <src-tmp>: replace dest's contents, keeping its mode.
_write_file() {
  cat "$2" >"$1"
  rm -f "$2"
}

# tfvars_set <file> <key> <hcl-value>: edit in place (fails loudly if missing).
tfvars_set() {
  local f=$1 k=$2 v=$3 cur tmp rc=0
  [[ -f "$f" ]] || die "missing file $f"
  cur=$(tfvars_get "$f" "$k")
  if [[ "$cur" == "$v" ]]; then
    info "unchanged ${f#"$BBM_REPO_ROOT/"}: $k = $v"
    return 0
  fi
  if [[ "$DRY_RUN" == 1 ]]; then
    info "[dry-run] would set ${f#"$BBM_REPO_ROOT/"}: $k = $v (was $cur)"
    return 0
  fi
  tmp=$(mktemp "${TMPDIR:-/tmp}/bbm-tfvars.XXXXXX")
  _tfvars_awk set "$f" "$k" "$v" >"$tmp" || rc=$?
  if [[ $rc -ne 0 ]]; then
    rm -f "$tmp"
    _tfvars_err "$rc" "$f" "$k"
  fi
  _write_file "$f" "$tmp"
  info "set ${f#"$BBM_REPO_ROOT/"}: $k = $v"
}

tfvars_set_if_present() { # same as tfvars_set, no-op when the key is absent
  tfvars_has "$1" "$2" || return 0
  tfvars_set "$@"
}

hcl_quote() { # hcl_quote <s> → "s" (escapes \ and ")
  local s=${1//\\/\\\\}
  s=${s//\"/\\\"}
  printf '"%s"' "$s"
}

# hcl_list_items <hcl-list> → one item per line, as written (quotes kept).
# Items must not contain commas (GUIDs, emails, numbers, namespaces).
hcl_list_items() {
  local v=$1 item parts=()
  v=${v#"${v%%[![:space:]]*}"}
  [[ "$v" == "[]" || "$v" == "null" || -z "$v" ]] && return 0
  [[ "$v" == \[*\] ]] || die "not an HCL list: $v"
  v=${v#[}
  v=${v%]}
  IFS=, read -r -a parts <<<"$v"
  for item in ${parts[@]+"${parts[@]}"}; do
    item=${item#"${item%%[![:space:]]*}"}
    item=${item%"${item##*[![:space:]]}"}
    [[ -n "$item" ]] && printf '%s\n' "$item"
  done
}

# hcl_list <item...> → ["a", "b"] (items are quoted unless --raw is first).
hcl_list() {
  local raw=0 out="" i
  if [[ "${1:-}" == --raw ]]; then
    raw=1
    shift
  fi
  for i in "$@"; do
    [[ -n "$i" ]] || continue
    if [[ $raw == 1 ]]; then out+="$i, "; else out+="$(hcl_quote "$i"), "; fi
  done
  printf '[%s]' "${out%, }"
}

# tfvars_list_add <file> <key> <string>: append a quoted string to a list if absent.
tfvars_list_add() {
  local f=$1 k=$2 item q cur items=() i found=0
  item=$3
  q=$(hcl_quote "$item")
  cur=$(tfvars_get "$f" "$k")
  while IFS= read -r i; do
    [[ -n "$i" ]] || continue
    items+=("$i")
    [[ "$i" == "$q" ]] && found=1
  done < <(hcl_list_items "$cur")
  if [[ $found == 1 ]]; then
    info "unchanged ${f#"$BBM_REPO_ROOT/"}: $k already contains $q"
    return 0
  fi
  items+=("$q")
  tfvars_set "$f" "$k" "$(hcl_list --raw "${items[@]}")"
}

# tfvars_replace_block <file> <content-file>: replace the lines between
# $HINT_BEGIN and $HINT_END (exclusive) with the content file. Both markers
# must be present exactly once, in order.
tfvars_replace_block() {
  local f=$1 content=$2 tmp nb ne
  [[ -f "$f" ]] || die "missing file $f"
  nb=$(grep -cxF "$HINT_BEGIN" "$f" || true)
  ne=$(grep -cxF "$HINT_END" "$f" || true)
  [[ "$nb" == 1 && "$ne" == 1 ]] ||
    die "$f: expected exactly one '$HINT_BEGIN' and one '$HINT_END' line (found $nb / $ne)"
  tmp=$(mktemp "${TMPDIR:-/tmp}/bbm-tfvars.XXXXXX")
  awk -v b="$HINT_BEGIN" -v e="$HINT_END" -v cf="$content" '
    $0 == b { print; while ((getline l < cf) > 0) print l; skip = 1; seen = 1; next }
    $0 == e { if (!seen) exit 7; skip = 0 }
    !skip { print }
  ' "$f" >"$tmp" || {
    rm -f "$tmp"
    die "$f: '$HINT_END' comes before '$HINT_BEGIN'"
  }
  if cmp -s "$tmp" "$f"; then
    rm -f "$tmp"
    info "unchanged ${f#"$BBM_REPO_ROOT/"}: bootstrap hint block"
    return 0
  fi
  if [[ "$DRY_RUN" == 1 ]]; then
    info "[dry-run] would replace the bootstrap hint block in ${f#"$BBM_REPO_ROOT/"}:"
    sed 's/^/    /' "$content" >&2
    rm -f "$tmp"
    return 0
  fi
  _write_file "$f" "$tmp"
  info "replaced the bootstrap hint block in ${f#"$BBM_REPO_ROOT/"}"
}

# tfvars_check_dupes <file>: die if any top-level key is assigned twice.
tfvars_check_dupes() {
  local d
  d=$(awk 'match($0, /^[A-Za-z_][A-Za-z0-9_-]*[ \t]*=/) { k = $0; sub(/[ \t]*=.*/, "", k); if (seen[k]++) print k }' "$1")
  [[ -z "$d" ]] || die "$1: keys assigned more than once: $(echo "$d" | tr '\n' ' ')"
}

# tf_fmt <file...>: keep `terraform fmt -check` (CI) green after edits.
tf_fmt() {
  [[ "$DRY_RUN" == 1 ]] && return 0
  have terraform || return 0
  terraform fmt -list=false "$@" >/dev/null || warn "terraform fmt failed on $*"
}

# ---- account switch -----------------------------------------------------------

# reset_tenant_fields: put every per-tenant / per-subscription value that
# infra/up.sh writes back to its committed placeholder, so the next up.sh on
# another tenant does not carry the old object ids, suffix or state account.
# Kept (they survive an account switch): dns_zone_name, alert_emails,
# github_reviewer_ids, github_repo.
reset_tenant_fields() {
  local envs="$BBM_TF_ROOT/envs" boot glob loc f empty='[]'
  boot="$envs/global/bootstrap.tfvars"
  glob="$envs/global/global.tfvars"
  loc=$(tfvars_get_string "$boot" location_abbr)
  info "resetting per-tenant fields in ${envs#"$BBM_REPO_ROOT/"} to placeholders (kept: dns_zone_name, alert_emails, github_reviewer_ids, github_repo)"
  tfvars_set "$boot" admin_object_ids "$empty"
  tfvars_set "$boot" power_operator_object_ids "$empty"
  tfvars_set_if_present "$boot" preregistered_resource_providers "$empty"
  while IFS= read -r f; do
    tfvars_set_if_present "$f" subscription_id "$(hcl_quote "$PLACEHOLDER_GUID")"
    tfvars_set_if_present "$f" suffix "$(hcl_quote "$PLACEHOLDER_SUFFIX")"
  done < <(find "$envs" -name '*.tfvars' | sort)
  tfvars_set_if_present "$glob" ephemeral_ci_principal_id null
  tfvars_set_if_present "$glob" preview_ci_principal_id null
  tfvars_set_if_present "$glob" secret_officer_sp_object_ids "$empty"
  tfvars_set_if_present "$glob" secret_officer_user_object_ids "$empty"
  while IFS= read -r f; do
    tfvars_set_if_present "$f" secret_officer_user_object_ids "$empty"
  done < <(find "$envs" -name 'data.tfvars' | sort)
  while IFS= read -r f; do
    tfvars_set_if_present "$f" resource_group_name "$(hcl_quote "rg-bbm-tfstate-$loc")"
    tfvars_set_if_present "$f" storage_account_name "$(hcl_quote "stbbmtfstate$PLACEHOLDER_SUFFIX")"
  done < <(find "$envs" -name 'backend*.hcl' | sort)
  tf_fmt -recursive "$envs"
}

# ---- terraform --------------------------------------------------------------

tf() { "$TF_SH" "$@"; } # tf <stack> <env> <cmd> [args]

# tf_out <stack> <env> <name>: raw output; under DRY_RUN a placeholder when absent.
tf_out() {
  local v
  if v=$("$TF_SH" "$1" "$2" output -raw "$3" 2>/dev/null) && [[ -n "$v" ]]; then
    printf '%s' "$v"
    return 0
  fi
  if [[ "$DRY_RUN" == 1 ]]; then
    printf '<%s.%s>' "$1" "$3"
    return 0
  fi
  die "terraform output '$3' of stack $1 ($2) is empty or missing"
}

tf_out_json() { # tf_out_json <stack> <env> <name>
  local v
  if v=$("$TF_SH" "$1" "$2" output -json "$3" 2>/dev/null) && [[ -n "$v" ]]; then
    printf '%s' "$v"
    return 0
  fi
  [[ "$DRY_RUN" == 1 ]] && {
    printf 'null'
    return 0
  }
  die "terraform output '$3' of stack $1 ($2) is missing"
}

# tf_plan_apply <stack> <env> [--destroy]: plan to a file, skip when there are
# no changes, confirm (unless ASSUME_YES), apply the saved plan.
tf_plan_apply() {
  local stack=$1 env=$2 mode=${3:-} plan="up.tfplan" rc=0 args=()
  [[ "$mode" == --destroy ]] && {
    plan="down.tfplan"
    args+=(-destroy)
  }
  if [[ "$DRY_RUN" == 1 ]]; then
    run "$TF_SH" "$stack" "$env" plan ${args[@]+"${args[@]}"} -out="$plan"
    run "$TF_SH" "$stack" "$env" apply "$plan"
    return 0
  fi
  run "$TF_SH" "$stack" "$env" plan ${args[@]+"${args[@]}"} -detailed-exitcode -out="$plan" || rc=$?
  case $rc in
    0)
      ok "$stack/$env: no changes"
      rm -f "$BBM_TF_ROOT/stacks/$stack/$plan"
      return 0
      ;;
    2) ;;
    *) die "$stack/$env: plan failed (exit $rc). Fix the error and re-run; completed steps are skipped." ;;
  esac
  if ! confirm "Apply the $stack/$env plan above?"; then
    rm -f "$BBM_TF_ROOT/stacks/$stack/$plan"
    die "$stack/$env: not applied (declined, or no terminal: pass --yes)"
  fi
  rc=0
  run "$TF_SH" "$stack" "$env" apply "$plan" || rc=$?
  rm -f "$BBM_TF_ROOT/stacks/$stack/$plan"
  return $rc
}

# ---- bootstrap backend switching --------------------------------------------
#
# The bootstrap stack creates the state account, so its first apply runs on
# local state. Two layouts are supported without hand-editing:
#   A) versions.tf has `backend "azurerm" {}` active (preferred): local mode
#      writes bbm_backend_override.tf with `backend "local" {}`.
#   B) the block is commented out: remote mode writes the override with
#      `backend "azurerm" {}`. The override is gitignored, so in this layout
#      other machines will not see the remote backend — commit the
#      uncommented block instead (warned about at run time).

BOOTSTRAP_DIR="$BBM_TF_ROOT/stacks/bootstrap"
BOOTSTRAP_OVERRIDE="$BOOTSTRAP_DIR/bbm_backend_override.tf"

bootstrap_backend_committed() {
  grep -Eq '^[[:space:]]*backend[[:space:]]+"azurerm"' "$BOOTSTRAP_DIR/versions.tf"
}

_write_override() { # _write_override <local|azurerm>
  if [[ "$DRY_RUN" == 1 ]]; then
    info "[dry-run] would write ${BOOTSTRAP_OVERRIDE#"$BBM_REPO_ROOT/"} (backend \"$1\")"
    return 0
  fi
  cat >"$BOOTSTRAP_OVERRIDE" <<EOF
# Generated by infra/up.sh / infra/down.sh; removed again when no longer needed.
# Gitignored (*_override.tf). Do not commit.
terraform {
  backend "$1" {}
}
EOF
}

_remove_override() {
  [[ -f "$BOOTSTRAP_OVERRIDE" ]] || return 0
  run rm -f "$BOOTSTRAP_OVERRIDE"
}

bootstrap_use_local_backend() {
  if bootstrap_backend_committed; then _write_override local; else _remove_override; fi
}

bootstrap_use_remote_backend() {
  if bootstrap_backend_committed; then
    _remove_override
  else
    warn "stacks/bootstrap/versions.tf has its backend \"azurerm\" block commented out; using a gitignored override."
    warn "Uncomment that block and commit it, or other machines will treat bootstrap as never applied."
    _write_override azurerm
  fi
}

# Local-mode init: tf.sh would pass -backend-config (it greps versions.tf), so
# call terraform directly.
bootstrap_init_local() {
  run terraform -chdir="$BOOTSTRAP_DIR" init -input=false -reconfigure
}

bootstrap_local_state_has_resources() {
  local f="$BOOTSTRAP_DIR/terraform.tfstate"
  [[ -s "$f" ]] && [[ "$(jq '.resources | length' "$f" 2>/dev/null || echo 0)" -gt 0 ]]
}

# ---- Cloudflare (optional; CLOUDFLARE_API_TOKEN) ----------------------------

CF_API="${CF_API:-https://api.cloudflare.com/client/v4}"

# cf_api <METHOD> <path> [json-body] → response JSON; dies when success != true.
cf_api() {
  local m=$1 p=$2 body=${3:-} resp
  local args=(-sS -X "$m" -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json")
  [[ -n "$body" ]] && args+=(--data "$body")
  resp=$(curl "${args[@]}" "$CF_API$p") || die "Cloudflare API $m $p: request failed"
  if [[ "$(printf '%s' "$resp" | jq -r '.success' 2>/dev/null)" != true ]]; then
    die "Cloudflare API $m $p failed: $(printf '%s' "$resp" | jq -c '.errors' 2>/dev/null || printf '%s' "$resp")"
  fi
  printf '%s' "$resp"
}

# cf_find_zone <fqdn> → "<zone-id> <zone-name>" for the closest parent domain
# on Cloudflare (the fqdn itself is skipped: it is the zone being delegated).
cf_find_zone() {
  local name=$1 cand id
  cand=${name#*.}
  while [[ "$cand" == *.* ]]; do
    id=$(cf_api GET "/zones?name=$cand" | jq -r '.result[0].id // empty')
    if [[ -n "$id" ]]; then
      printf '%s %s\n' "$id" "$cand"
      return 0
    fi
    cand=${cand#*.}
  done
  return 1
}

norm_ns() { # lowercase, strip trailing dot, sort -u (one per line on stdin)
  tr '[:upper:]' '[:lower:]' | sed -e 's/[[:space:]]//g' -e 's/\.$//' | grep -v '^$' | sort -u
}

# cf_sync_ns <fqdn> <ns...>: upsert NS records for fqdn in its parent zone;
# delete NS records for that name that are not in the list.
cf_sync_ns() {
  local name=$1 zid zname want have_ids rid content ns
  shift
  want=$(printf '%s\n' "$@" | norm_ns)
  read -r zid zname < <(cf_find_zone "$name") ||
    die "no Cloudflare zone found for any parent of $name (token needs Zone:Read + DNS:Edit on it)"
  info "Cloudflare zone $zname ($zid): syncing NS records for $name"
  have_ids=$(cf_api GET "/zones/$zid/dns_records?type=NS&name=$name&per_page=100" |
    jq -r '.result[] | "\(.id) \(.content)"')
  while read -r rid content; do
    [[ -n "$rid" ]] || continue
    content=$(printf '%s\n' "$content" | norm_ns)
    if ! printf '%s\n' "$want" | grep -qxF "$content"; then
      run cf_api DELETE "/zones/$zid/dns_records/$rid" >/dev/null
      info "deleted stale NS $name -> $content"
    fi
  done <<<"$have_ids"
  for ns in $want; do
    if printf '%s\n' "$have_ids" | awk '{print $2}' | norm_ns | grep -qxF "$ns"; then
      info "NS $name -> $ns already present"
      continue
    fi
    run cf_api POST "/zones/$zid/dns_records" \
      "$(jq -nc --arg n "$name" --arg c "$ns" '{type: "NS", name: $n, content: $c, ttl: 3600}')" >/dev/null
    info "created NS $name -> $ns"
  done
}

# cf_remove_azure_ns <fqdn>: delete NS records for fqdn that point at Azure DNS.
cf_remove_azure_ns() {
  local name=$1 zid zname rid content
  read -r zid zname < <(cf_find_zone "$name") || {
    warn "no Cloudflare zone found for any parent of $name; nothing to remove"
    return 0
  }
  while read -r rid content; do
    [[ -n "$rid" ]] || continue
    run cf_api DELETE "/zones/$zid/dns_records/$rid" >/dev/null
    info "deleted NS $name -> $content (zone $zname)"
  done < <(cf_api GET "/zones/$zid/dns_records?type=NS&name=$name&per_page=100" |
    jq -r '.result[] | select(.content | test("azure-dns\\.")) | "\(.id) \(.content)"')
}

# ---- public DNS -------------------------------------------------------------

# public_ns <zone>: NS records as seen by 1.1.1.1 (dig, else nslookup, else DoH).
public_ns() {
  local z=$1
  if have dig; then
    dig +short NS "$z" @1.1.1.1 2>/dev/null | norm_ns
  elif have nslookup; then
    nslookup -type=NS "$z" 1.1.1.1 2>/dev/null | awk '/nameserver = / { print $NF }' | norm_ns
  else
    curl -sS -H 'accept: application/dns-json' "https://cloudflare-dns.com/dns-query?name=$z&type=NS" 2>/dev/null |
      jq -r '.Answer[]? | select(.type == 2) | .data' | norm_ns
  fi
}

# wait_for_delegation <zone> <timeout-s> <ns...>: true once public NS == list.
wait_for_delegation() {
  local z=$1 timeout=$2 want got start
  shift 2
  want=$(printf '%s\n' "$@" | norm_ns)
  start=$(date +%s)
  while true; do
    got=$(public_ns "$z" || true)
    if [[ -n "$got" && "$got" == "$want" ]]; then
      ok "delegation of $z resolves publicly"
      return 0
    fi
    if [[ $(($(date +%s) - start)) -ge $timeout ]]; then
      warn "public NS for $z after ${timeout}s: ${got:-<none>} (want: $(echo "$want" | tr '\n' ' '))"
      return 1
    fi
    info "waiting for NS delegation of $z (public: ${got:-<none>}) ..."
    sleep "${BBM_DNS_POLL:-20}"
  done
}
