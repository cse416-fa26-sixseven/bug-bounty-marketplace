#!/usr/bin/env bash
# Offline self-tests for infra/lib/common.sh, infra/up.sh and infra/down.sh.
# No Azure, GitHub or Cloudflare access: az/gh/terraform/kubectl/... are PATH
# shims, and everything runs on temp copies of infra/terraform.
#
#   infra/lib/test-common.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
real_terraform=$(command -v terraform || true)

T=$(mktemp -d "${TMPDIR:-/tmp}/bbm-test.XXXXXX")
trap 'rm -rf "$T"' EXIT

pass=0 failed=0
ok_() {
  pass=$((pass + 1))
  printf '  ok   %s\n' "$1"
}
bad() {
  failed=$((failed + 1))
  printf '  FAIL %s\n' "$1"
}
check() { # check <name> <cmd...>
  local n=$1
  shift
  if "$@" >/dev/null 2>&1; then ok_ "$n"; else bad "$n"; fi
}
check_fails() { # the command must exit non-zero (dies are expected)
  local n=$1
  shift
  if ("$@") >/dev/null 2>&1; then bad "$n (expected failure)"; else ok_ "$n"; fi
}
eq() { # eq <name> <got> <want>
  if [[ "$2" == "$3" ]]; then ok_ "$1"; else bad "$1: got [$2] want [$3]"; fi
}

# A temp copy of infra/terraform that satisfies the tfvars contract even if the
# Terraform side has not landed yet (dns_zone_name, hint markers, test env).
make_tree() {
  local dst=$1
  mkdir -p "$dst"
  (cd "$repo/infra/terraform" && tar --exclude=.terraform -cf - scripts envs stacks/bootstrap) | (cd "$dst" && tar -xf -)
  local b="$dst/envs/global/bootstrap.tfvars" g="$dst/envs/global/global.tfvars"
  grep -q '^dns_zone_name' "$b" || printf '\ndns_zone_name = "" # set by infra/up.sh\n' >>"$b"
  if ! grep -qF '# >>> bootstrap hint' "$g"; then
    grep -vE '^(subscription_id|suffix|ephemeral_ci_principal_id|secret_officer_sp_object_ids)[[:space:]]*=' "$g" >"$g.tmp"
    {
      echo '# >>> bootstrap hint (written by infra/up.sh)'
      echo 'subscription_id = "00000000-0000-0000-0000-000000000000"'
      echo 'suffix          = "0000"'
      echo '# <<< bootstrap hint'
      cat "$g.tmp"
    } >"$g"
    rm -f "$g.tmp"
  fi
  if [[ ! -f "$dst/envs/test/data.tfvars" ]]; then
    sed 's/"staging"/"test"/' "$dst/envs/staging/data.tfvars" >"$dst/envs/test/data.tfvars"
    sed 's/"staging"/"test"/' "$dst/envs/staging/compute.tfvars" >"$dst/envs/test/compute.tfvars"
  fi
}

# ---------------------------------------------------------------------------
echo "== common.sh helpers"
TREE="$T/tree"
make_tree "$TREE"
export BBM_TF_ROOT="$TREE" BBM_REPO_ROOT="$repo" NO_COLOR=1
# shellcheck source-path=SCRIPTDIR source=common.sh
source "$here/common.sh"
set +e # checks handle failures themselves
B="$TREE/envs/global/bootstrap.tfvars"
G="$TREE/envs/global/global.tfvars"
D="$TREE/envs/staging/data.tfvars"
C="$TREE/envs/prod/compute.tfvars"

eq "get string" "$(tfvars_get_string "$B" location)" "eastus2"
eq "get list" "$(tfvars_get "$B" admin_object_ids)" "[]"
check_fails "get missing key dies" tfvars_get "$B" no_such_key
check_fails "get multi-line value dies" tfvars_get "$D" subnet_cidrs

tfvars_set "$B" subscription_id '"11111111-2222-3333-4444-555555555555"' 2>/dev/null
eq "set value" "$(tfvars_get_string "$B" subscription_id)" "11111111-2222-3333-4444-555555555555"
tfvars_set "$D" suffix '"ab12"' 2>/dev/null
eq "set keeps trailing comment" "$(grep '^suffix' "$D")" 'suffix          = "ab12" # bootstrap output: suffix (same as envs/global/global.tfvars)'
eq "set leaves other lines alone" "$(diff "$repo/infra/terraform/envs/staging/data.tfvars" "$D" | grep -c '^[<>]')" "2"
check_fails "set missing key dies" tfvars_set "$B" no_such_key '"x"'
check_fails "set multi-line value dies" tfvars_set "$D" subnet_cidrs '{}'
printf 'dup = 1\ndup = 2\n' >"$T/dup.tfvars"
check_fails "set duplicated key dies" tfvars_set "$T/dup.tfvars" dup 3
check_fails "check_dupes finds duplicates" tfvars_check_dupes "$T/dup.tfvars"
check "set_if_present skips absent key" tfvars_set_if_present "$B" no_such_key '"x"'

printf 'x = "a#b // c" # real comment\ny = [] # c2\n' >"$T/q.tfvars"
eq "hash inside string is not a comment" "$(tfvars_get "$T/q.tfvars" x)" '"a#b // c"'
tfvars_set "$T/q.tfvars" x '"z"' 2>/dev/null
eq "comment after string value kept" "$(head -n1 "$T/q.tfvars")" 'x = "z" # real comment'

tfvars_list_add "$D" secret_officer_user_object_ids "aaaaaaaa-0000-0000-0000-000000000001" 2>/dev/null
tfvars_list_add "$D" secret_officer_user_object_ids "aaaaaaaa-0000-0000-0000-000000000001" 2>/dev/null
tfvars_list_add "$D" secret_officer_user_object_ids "aaaaaaaa-0000-0000-0000-000000000002" 2>/dev/null
eq "list add is idempotent" "$(tfvars_get "$D" secret_officer_user_object_ids)" \
  '["aaaaaaaa-0000-0000-0000-000000000001", "aaaaaaaa-0000-0000-0000-000000000002"]'
tfvars_list_add "$D" secret_officer_sp_object_ids "s1" 2>/dev/null
eq "list add keeps comment" "$(grep '^secret_officer_sp_object_ids' "$D")" \
  'secret_officer_sp_object_ids = ["s1"] # extra service principals (CI can apply)'
eq "hcl_list quotes" "$(hcl_list a 'b"c')" '["a", "b\"c"]'
eq "hcl_list --raw" "$(hcl_list --raw 1 22)" '[1, 22]'
eq "hcl_list empty" "$(hcl_list)" '[]'

kv_before=$(cat "$C")
tfvars_set "$C" kubernetes_version '"1.33"' 2>/dev/null
eq "kubernetes_version set" "$(tfvars_get_string "$C" kubernetes_version)" "1.33"
eq "compute.tfvars one line changed" "$(diff <(echo "$kv_before") "$C" | grep -c '^[<>]')" "2"

cat >"$T/hint" <<'EOF'
subscription_id           = "11111111-2222-3333-4444-555555555555"
suffix                    = "ab12"
ephemeral_ci_principal_id = "eeeeeeee-0000-0000-0000-000000000000"
secret_officer_sp_object_ids = ["ffffffff-0000-0000-0000-000000000000"]
# Add admin users to secret_officer_user_object_ids and apply locally as an Owner.
EOF
tfvars_replace_block "$G" "$T/hint" 2>/dev/null
tfvars_replace_block "$G" "$T/hint" 2>/dev/null # idempotent
eq "hint block replaced once" "$(grep -c '^suffix' "$G")" "1"
eq "hint suffix readable" "$(tfvars_get_string "$G" suffix)" "ab12"
check "no duplicate keys after hint" tfvars_check_dupes "$G"
check "markers kept" grep -qxF "$HINT_END" "$G"
cp "$G" "$T/nomark.tfvars"
grep -vF '# <<< bootstrap hint' "$G" >"$T/nomark.tfvars"
check_fails "hint replace without end marker dies" tfvars_replace_block "$T/nomark.tfvars" "$T/hint"
if [[ -n "$real_terraform" ]]; then
  tf_fmt "$G" "$D" "$B" "$C"
  check "edited tfvars pass terraform fmt -check" terraform fmt -check "$G" "$D" "$B" "$C"
else
  echo "  skip terraform fmt check (no terraform on PATH)"
fi

# reset_tenant_fields (down.sh --all / up.sh on a subscription mismatch)
RT="$T/tree-reset"
make_tree "$RT"
BBM_TF_ROOT="$RT"
RB="$RT/envs/global/bootstrap.tfvars" RG_="$RT/envs/global/global.tfvars"
OLD=aaaaaaaa-0000-0000-0000-00000000000a
{
  tfvars_set "$RB" subscription_id '"11111111-2222-3333-4444-555555555555"'
  tfvars_set "$RB" dns_zone_name '"bbm.example.com"'
  tfvars_set "$RB" alert_emails '["me@uni.edu"]'
  tfvars_set "$RB" github_reviewer_ids '[12345]'
  tfvars_list_add "$RB" admin_object_ids "$OLD"
  tfvars_list_add "$RB" power_operator_object_ids "$OLD"
  tfvars_set "$RB" preregistered_resource_providers '["Microsoft.Network"]'
  { cat "$T/hint"; echo 'dns_zone_name = "bbm.example.com"'; } >"$T/hint2"
  tfvars_replace_block "$RG_" "$T/hint2"
  tfvars_list_add "$RG_" secret_officer_user_object_ids "$OLD"
  for e in test staging prod; do
    tfvars_set "$RT/envs/$e/data.tfvars" suffix '"ab12"'
    tfvars_list_add "$RT/envs/$e/data.tfvars" secret_officer_user_object_ids "$OLD"
    tfvars_set "$RT/envs/$e/compute.tfvars" subscription_id '"11111111-2222-3333-4444-555555555555"'
  done
  for f in "$RT"/envs/*/backend*.hcl; do
    tfvars_set "$f" storage_account_name '"stbbmtfstateab12"'
    tfvars_set "$f" resource_group_name '"rg-bbm-tfstate-xyz"'
  done
} 2>/dev/null
check "reset: old values present before" grep -qF "$OLD" "$RT/envs/prod/data.tfvars"
reset_out=$(reset_tenant_fields 2>&1)
eq "reset: bootstrap subscription_id" "$(tfvars_get_string "$RB" subscription_id)" "$PLACEHOLDER_GUID"
eq "reset: admin_object_ids" "$(tfvars_get "$RB" admin_object_ids)" "[]"
eq "reset: power_operator_object_ids" "$(tfvars_get "$RB" power_operator_object_ids)" "[]"
eq "reset: preregistered providers" "$(tfvars_get "$RB" preregistered_resource_providers)" "[]"
eq "reset: global suffix" "$(tfvars_get_string "$RG_" suffix)" "$PLACEHOLDER_SUFFIX"
eq "reset: global ephemeral principal" "$(tfvars_get "$RG_" ephemeral_ci_principal_id)" "null"
eq "reset: global sp officers" "$(tfvars_get "$RG_" secret_officer_sp_object_ids)" "[]"
eq "reset: global user officers" "$(tfvars_get "$RG_" secret_officer_user_object_ids)" "[]"
for e in test staging prod; do
  eq "reset: $e data officers" "$(tfvars_get "$RT/envs/$e/data.tfvars" secret_officer_user_object_ids)" "[]"
  eq "reset: $e data suffix" "$(tfvars_get_string "$RT/envs/$e/data.tfvars" suffix)" "$PLACEHOLDER_SUFFIX"
  eq "reset: $e compute subscription" "$(tfvars_get_string "$RT/envs/$e/compute.tfvars" subscription_id)" "$PLACEHOLDER_GUID"
done
eq "reset: no old object id left" "$(grep -rlF "$OLD" "$RT/envs" | wc -l | tr -d ' ')" "0"
eq "reset: backends back to committed placeholders" \
  "$(cd "$RT/envs" && find . -name 'backend*.hcl' | sort | xargs cat | cksum)" \
  "$(cd "$repo/infra/terraform/envs" && find . -name 'backend*.hcl' | sort | xargs cat | cksum)"
eq "reset: keeps dns_zone_name" "$(tfvars_get_string "$RB" dns_zone_name)" "bbm.example.com"
eq "reset: keeps hint dns_zone_name" "$(tfvars_get_string "$RG_" dns_zone_name)" "bbm.example.com"
eq "reset: keeps alert_emails" "$(tfvars_get "$RB" alert_emails)" '["me@uni.edu"]'
eq "reset: keeps github_reviewer_ids" "$(tfvars_get "$RB" github_reviewer_ids)" "[12345]"
if grep -qE '^bbm: set .*/envs/global/bootstrap.tfvars: admin_object_ids = \[\]$' <<<"$reset_out"; then
  ok_ "reset: prints what it reset"
else
  bad "reset: prints what it reset"
fi
if [[ -n "$real_terraform" ]]; then
  check "reset tfvars pass terraform fmt -check" terraform fmt -check -recursive "$RT/envs"
fi
BBM_TF_ROOT="$TREE"

# shellcheck disable=SC2034 # read by common.sh
DRY_RUN=1
before=$(cat "$B")
tfvars_set "$B" location '"centralus"' 2>/dev/null
tfvars_list_add "$B" admin_object_ids x 2>/dev/null
eq "dry-run does not write" "$(cat "$B")" "$before"
DRY_RUN=0

check "zone ok" is_zone_name bbm.example.com
check "zone ok (deep)" is_zone_name a-1.b.example.co
check_fails "zone rejects single label" is_zone_name localhost
check_fails "zone rejects uppercase" is_zone_name BBM.example.com
check_fails "zone rejects trailing dot" is_zone_name bbm.example.com.
check_fails "zone rejects leading hyphen" is_zone_name -bbm.example.com
check "guid ok" is_guid 11111111-2222-3333-4444-555555555555
check_fails "guid rejects uppercase" is_guid 11111111-2222-3333-4444-55555555555A
eq "norm_ns" "$(printf 'NS2.Azure-DNS.net.\nns1-01.azure-dns.com.\nns1-01.azure-dns.com\n' | norm_ns | tr '\n' ' ')" \
  "ns1-01.azure-dns.com ns2.azure-dns.net "

# bootstrap backend switching (layout: commented block, as committed today, and active block)
BOOT_TF="$TREE/stacks/bootstrap/versions.tf"
bootstrap_use_remote_backend 2>/dev/null
if bootstrap_backend_committed; then
  check "active block: remote mode needs no override" test ! -f "$BOOTSTRAP_OVERRIDE"
  bootstrap_use_local_backend
  check "active block: local mode writes backend local" grep -q 'backend "local"' "$BOOTSTRAP_OVERRIDE"
else
  check "commented block: remote mode writes azurerm override" grep -q 'backend "azurerm"' "$BOOTSTRAP_OVERRIDE"
  bootstrap_use_local_backend
  check "commented block: local mode removes override" test ! -f "$BOOTSTRAP_OVERRIDE"
  sed 's|^  # backend "azurerm" {}|  backend "azurerm" {}|' "$BOOT_TF" >"$BOOT_TF.tmp" && mv "$BOOT_TF.tmp" "$BOOT_TF"
  check "uncommented copy detected" bootstrap_backend_committed
  bootstrap_use_local_backend
  check "active block: local mode writes backend local" grep -q 'backend "local"' "$BOOTSTRAP_OVERRIDE"
fi
bootstrap_use_remote_backend 2>/dev/null
check "active block: remote mode removes override" test ! -f "$BOOTSTRAP_OVERRIDE"
set -e

# ---------------------------------------------------------------------------
echo "== up.sh / down.sh --dry-run with stubbed CLIs"
SHIM="$T/bin"
LOG="$T/calls.log"
mkdir -p "$SHIM"
: >"$LOG"

cat >"$SHIM/az" <<'EOF'
#!/usr/bin/env bash
echo "az $*" >>"$BBM_TEST_LOG"
q=""; prev=""
for a in "$@"; do [[ "$prev" == --query ]] && q=$a; prev=$a; done
case "$1 $2" in
  "account show")
    case "$q" in
      name) echo "bbm-student-sub" ;; tenantId) echo "99999999-0000-0000-0000-000000000000" ;;
      user.name) echo "me@uni.edu" ;; *) ;; esac ;;
  "account set") ;;
  "ad signed-in-user") echo "aaaaaaaa-0000-0000-0000-000000000001" ;;
  "role assignment") echo 1 ;;
  "provider list") printf 'Microsoft.Network\nMicrosoft.Storage\nMicrosoft.Web\n' ;;
  "group exists") echo false ;;
  "storage account") echo "stbbmtfstateab12" ;;
  "vm list-usage") echo '[{"name":{"value":"cores"},"currentValue":0,"limit":10},{"name":{"value":"standardBASv2Family"},"currentValue":0,"limit":2}]' ;;
  "postgres flexible-server") echo '[{"supportedServerEditions":[{"name":"Burstable","supportedServerSkus":[{"name":"Standard_B1ms"}]}]}]' ;;
  "aks get-versions") echo '{"values":[{"version":"1.32","isPreview":null},{"version":"1.33","isPreview":null,"isDefault":true},{"version":"1.35","isPreview":true}]}' ;;
  "keyvault list-deleted") printf 'kv-bbm-stg-ab12\teastus2\n' ;;
  *) exit 1 ;;
esac
EOF

cat >"$SHIM/gh" <<'EOF'
#!/usr/bin/env bash
echo "gh $*" >>"$BBM_TEST_LOG"
case "$1" in
  auth) exit 0 ;;
  repo) [[ "$2" == view ]] && { echo "neworg/bbm-renamed"; exit 0; }; exit 1 ;;
  api) [[ "$2" == user ]] && { echo 12345; exit 0; }; [[ "$2" == repos/* ]] && { echo true; exit 0; }; exit 1 ;;
  *) exit 1 ;;
esac
EOF

cat >"$SHIM/terraform" <<'EOF'
#!/usr/bin/env bash
echo "terraform $*" >>"$BBM_TEST_LOG"
args=("$@"); [[ "${args[0]}" == -chdir=* ]] && { chdir=${args[0]#-chdir=}; args=("${args[@]:1}"); }
case "${args[0]}" in
  version) echo '{"terraform_version":"1.9.8"}' ;;
  output)
    [[ "${chdir:-}" == */stacks/bootstrap ]] || exit 1
    case "${args[2]}" in
      suffix) printf ab12 ;;
      tfstate_resource_group) printf rg-bbm-tfstate-eus2 ;;
      tfstate_storage_account) printf stbbmtfstateab12 ;;
      global_tfvars_hint) printf 'subscription_id = "11111111-2222-3333-4444-555555555555"\nsuffix = "ab12"\n' ;;
      dns_name_servers) echo '["ns1-01.azure-dns.com.","ns2-01.azure-dns.net.","ns3-01.azure-dns.org.","ns4-01.azure-dns.info."]' ;;
      gh_setup_commands) cat <<'GH'
#!/usr/bin/env bash
set -euo pipefail
gh variable set ACR_NAME --repo o/r --body 'acrbbmab12'
gh variable set TFSTATE_RG --repo o/r --body 'rg'

# --- environment: prod (gh-bbm-prod)
echo '{}' | gh api -X PUT repos/o/r/environments/prod --input -
gh variable set AZURE_CLIENT_ID --repo o/r --env prod --body 'x'
echo '{}' | gh api -X PUT repos/o/r/environments/test-infra --input -
GH
      ;;
      *) exit 1 ;;
    esac ;;
  *) exit 1 ;;
esac
EOF
for t in kubectl kubelogin helm; do
  # shellcheck disable=SC2016 # $* / $BBM_TEST_LOG expand inside the shim
  printf '#!/usr/bin/env bash\necho "%s $*" >>"$BBM_TEST_LOG"\n' "$t" >"$SHIM/$t"
done
chmod +x "$SHIM"/*

TREE2="$T/tree2"
make_tree "$TREE2"
snapshot() { (cd "$TREE2" && find envs stacks -type f | sort | xargs cat | cksum); }
snap0=$(snapshot)
SUB=11111111-2222-3333-4444-555555555555
export BBM_TEST_LOG="$LOG"
run_script() { # run_script <script> <args...> → output in $T/out
  # shellcheck disable=SC2086 # RUN_WRAP is empty or a single word (setsid -w)
  ${RUN_WRAP:-} env -u CLOUDFLARE_API_TOKEN PATH="$SHIM:/usr/bin:/bin" BBM_TF_ROOT="${RUN_TREE:-$TREE2}" BBM_REPO_ROOT="$repo" \
    NO_COLOR=1 "$repo/infra/$1" "${@:2}" >"$T/out" 2>&1
}

if run_script up.sh --subscription "$SUB" --zone bbm.example.com --yes --dry-run --prod; then
  ok_ "up.sh --dry-run exits 0"
else
  bad "up.sh --dry-run exits 0"
  sed 's/^/      /' "$T/out"
fi
out=$(cat "$T/out")
has() { if grep -qF -- "$2" <<<"$out"; then ok_ "$1"; else bad "$1 (missing: $2)"; fi; }
has "up: would write dns_zone_name" 'envs/global/bootstrap.tfvars: dns_zone_name = "bbm.example.com"'
has "up: admin id added" 'admin_object_ids = ["aaaaaaaa-0000-0000-0000-000000000001"]'
has "up: preregistered = registered ∩ bootstrap list" 'preregistered_resource_providers = ["Microsoft.Network", "Microsoft.Storage"]'
has "up: alert email defaulted" 'alert_emails = ["me@uni.edu"]'
has "up: reviewer from gh user" 'github_reviewer_ids = [12345]'
has "up: BASv2 quota warning" 'standardBASv2Family has only 2 vCPUs free'
has "up: kubernetes_version fixed" 'kubernetes_version = "1.33"'
has "up: bootstrap plan" 'tf.sh bootstrap global plan -out=up.tfplan'
has "up: migrate" 'init -migrate-state -force-copy'
has "up: suffix written" 'suffix = "ab12"'
has "up: backend account written" 'storage_account_name = "stbbmtfstateab12"'
has "up: NS table" 'bbm.example.com                          NS   ns1-01.azure-dns.com.'
has "up: gh script run" 'bash '
has "up: acr import postgres" 'mirror/postgres:16-alpine'
has "up: acr import curl" 'mirror/curl:8.10.1'
has "up: prod env included" 'data prod init -reconfigure'
has "up: llm-api-key placeholder" 'llm-api-key --value placeholder-set-me'
has "up: platform install" 'install.sh test --values'
has "up: github_repo follows gh repo view" 'github_repo = "neworg/bbm-renamed"'
has "up: gh admin check uses the new repo" 'gh: admin on neworg/bbm-renamed'
if grep -qF 'filled in for subscription' <<<"$out"; then bad "up: no tenant warning on placeholder"; else ok_ "up: no tenant warning on placeholder"; fi
eq "up: dry-run left the tree untouched" "$(snapshot)" "$snap0"
mut=$(grep -E '^az .*(import|secret set|purge|create|delete( |$)| update)|^gh (variable|api -X)|^terraform .*(apply|destroy|init|plan)|^(kubectl|kubelogin|helm) ' "$LOG" || true)
eq "up: no mutating CLI calls" "$mut" ""

check_fails "up: missing --subscription" run_script up.sh

# tenant switch: bootstrap.tfvars still holds another subscription's values
TREE3="$T/tree3"
make_tree "$TREE3"
OLD_SUB=22222222-0000-0000-0000-000000000000
{
  BBM_TF_ROOT="$TREE3" tfvars_set "$TREE3/envs/global/bootstrap.tfvars" subscription_id "\"$OLD_SUB\""
  BBM_TF_ROOT="$TREE3" tfvars_set "$TREE3/envs/global/bootstrap.tfvars" admin_object_ids '["bbbbbbbb-0000-0000-0000-00000000000b"]'
} 2>/dev/null
if RUN_TREE="$TREE3" run_script up.sh --subscription "$SUB" --zone bbm.example.com --yes --dry-run; then
  ok_ "up: tenant mismatch --yes --dry-run exits 0"
else
  bad "up: tenant mismatch --yes --dry-run exits 0"
  sed 's/^/      /' "$T/out"
fi
out=$(cat "$T/out")
has "up: tenant mismatch warned" "filled in for subscription $OLD_SUB, not $SUB"
has "up: tenant mismatch resets admin ids" 'admin_object_ids = [] (was ["bbbbbbbb-0000-0000-0000-00000000000b"])'
has "up: tenant mismatch resets subscription" "subscription_id = \"$PLACEHOLDER_GUID\" (was \"$OLD_SUB\")"
if setsid -w true 2>/dev/null; then # no controlling terminal and no --yes: refuse, don't guess
  if RUN_WRAP="setsid -w" RUN_TREE="$TREE3" run_script up.sh --subscription "$SUB" --zone bbm.example.com --dry-run; then
    bad "up: tenant mismatch without --yes or a tty dies"
  else
    ok_ "up: tenant mismatch without --yes or a tty dies"
  fi
  if grep -qF 'per-tenant fields not reset' "$T/out"; then ok_ "up: tenant mismatch refusal explains"; else bad "up: tenant mismatch refusal explains"; fi
else
  echo "  skip tenant-mismatch no-tty check (no setsid -w)"
fi
check_fails "up: bad env name" run_script up.sh --subscription "$SUB" --envs dev --dry-run
check "up: --help" run_script up.sh --help
if grep -qi 'one-command' "$T/out"; then ok_ "up: --help prints usage"; else bad "up: --help prints usage"; fi

: >"$LOG"
# down --all resets per-tenant fields; prefill TREE2 as up.sh would have
{
  BBM_TF_ROOT="$TREE2" tfvars_set "$TREE2/envs/global/bootstrap.tfvars" subscription_id "\"$SUB\""
  BBM_TF_ROOT="$TREE2" tfvars_list_add "$TREE2/envs/global/bootstrap.tfvars" admin_object_ids aaaaaaaa-0000-0000-0000-000000000001
  BBM_TF_ROOT="$TREE2" tfvars_list_add "$TREE2/envs/test/data.tfvars" secret_officer_user_object_ids aaaaaaaa-0000-0000-0000-000000000001
  BBM_TF_ROOT="$TREE2" tfvars_set "$TREE2/envs/global/backend.hcl" storage_account_name '"stbbmtfstateab12"'
  BBM_TF_ROOT="$TREE2" tfvars_set "$TREE2/envs/global/bootstrap.tfvars" dns_zone_name '"bbm.example.com"'
} 2>/dev/null
snap0=$(snapshot)
if run_script down.sh --subscription "$SUB" --all --yes --dry-run; then
  ok_ "down.sh --all --dry-run exits 0"
else
  bad "down.sh --all --dry-run exits 0"
  sed 's/^/      /' "$T/out"
fi
out=$(cat "$T/out")
has "down: compute before data (test)" 'tf.sh compute test plan -destroy -out=down.tfplan'
has "down: global destroy" 'tf.sh global global plan -destroy'
has "down: gh var delete parsed" 'gh variable delete ACR_NAME --repo'
has "down: gh env delete parsed" 'repos/cse416-fa26-sixseven/bug-bounty-marketplace/environments/test-infra'
has "down: bootstrap state pull" 'tf.sh bootstrap global state pull'
has "down: bootstrap destroy" 'tf.sh bootstrap global plan -destroy'
has "down: purge vault" 'az keyvault purge -n kv-bbm-stg-ab12 -l eastus2'
has "down: resets admin ids" 'bootstrap.tfvars: admin_object_ids = [] (was ["aaaaaaaa-0000-0000-0000-000000000001"])'
has "down: resets subscription" "bootstrap.tfvars: subscription_id = \"$PLACEHOLDER_GUID\" (was \"$SUB\")"
has "down: resets data officers" 'test/data.tfvars: secret_officer_user_object_ids = [] (was'
has "down: resets backend account" 'global/backend.hcl: storage_account_name = "stbbmtfstate0000" (was "stbbmtfstateab12")'
if grep -qE 'dns_zone_name|alert_emails|github_reviewer_ids' <<<"$(grep 'would set' <<<"$out")"; then
  bad "down: keeps dns_zone_name / alert_emails / github_reviewer_ids"
else
  ok_ "down: keeps dns_zone_name / alert_emails / github_reviewer_ids"
fi
order=$(grep -oE 'tf\.sh (compute|data|global|bootstrap) [a-z]+ plan' <<<"$out" | awk '{print $2"/"$3}' | tr '\n' ' ')
eq "down: destroy order" "$order" "compute/test data/test compute/staging data/staging compute/prod data/prod global/global bootstrap/global "
if grep -q 'gh variable delete AZURE_CLIENT_ID' <<<"$out"; then bad "down: env-scoped variable not deleted as repo var"; else ok_ "down: env-scoped variable not deleted as repo var"; fi
eq "down: dry-run left the tree untouched" "$(snapshot)" "$snap0"
mut=$(grep -E '^az .*(purge|delete( |$))|^gh (variable|api -X)|^terraform .*(apply|destroy|init|plan|state)' "$LOG" || true)
eq "down: no mutating CLI calls" "$mut" ""
check_fails "down: needs --envs or --all" run_script down.sh --subscription "$SUB" --dry-run

echo
echo "passed: $pass, failed: $failed"
[[ $failed -eq 0 ]]
