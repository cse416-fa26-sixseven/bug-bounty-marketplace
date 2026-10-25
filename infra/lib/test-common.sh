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
  (cd "$repo/infra/terraform" && tar --exclude=.terraform -cf - scripts envs stacks/bootstrap modules/naming) | (cd "$dst" && tar -xf -)
  local b="$dst/envs/global/bootstrap.tfvars" g="$dst/envs/global/global.tfvars"
  grep -q '^dns_zone_name' "$b" || printf '\ndns_zone_name = "" # set by infra/up.sh\n' >>"$b"
  if ! grep -qF '# >>> bootstrap hint' "$g"; then
    grep -vE '^(subscription_id|suffix|ephemeral_ci_principal_id|preview_ci_principal_id|secret_officer_sp_object_ids)[[:space:]]*=' "$g" >"$g.tmp"
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
  untenant "$dst"
  pin_fixture_regions "$dst"
}

# pin_fixture_regions <tree>: give the copy a fixed region layout (test ncus,
# staging frc, prod cac, every env on Standard_B4as_v2), so the assertions
# below don't depend on the regions the real subscription uses. The real
# envs/** layout is checked for consistency separately ("repo:" checks).
pin_fixture_regions() {
  local dst=$1 e loc abbr f
  for pair in test=northcentralus/ncus staging=francecentral/frc prod=canadacentral/cac; do
    e=${pair%%=*} loc=${pair#*=}; abbr=${loc#*/}; loc=${loc%/*}
    for f in "$dst/envs/$e/data.tfvars" "$dst/envs/$e/compute.tfvars"; do
      sed -E -e "s/^(location[[:space:]]*=[[:space:]]*)\"[^\"]*\"/\1\"$loc\"/" \
        -e "s/^(location_abbr[[:space:]]*=[[:space:]]*)\"[^\"]*\"/\1\"$abbr\"/" \
        -e 's/^(system_vm_size[[:space:]]*=[[:space:]]*)"[^"]*"/\1"Standard_B4as_v2"/' "$f" >"$f.tmp"
      cat "$f.tmp" >"$f"
      rm -f "$f.tmp"
    done
    for f in "$dst/envs/global/bootstrap.tfvars" "$dst/envs/global/global.tfvars"; do
      sed -E "s/^([[:space:]]+${e}[[:space:]]*=[[:space:]]*\{ location = )\"[^\"]*\", location_abbr = \"[^\"]*\"/\1\"$loc\", location_abbr = \"$abbr\"/" "$f" >"$f.tmp"
      cat "$f.tmp" >"$f"
      rm -f "$f.tmp"
    done
  done
}

# untenant <tree>: put the per-tenant values infra/up.sh writes (subscription,
# suffix, object ids, emails, reviewers, providers, zone, state account) back
# to the committed placeholders, so the suite does not depend on whether a
# filled-in subscription has been committed. Regions are kept.
untenant() {
  local f
  while IFS= read -r f; do
    sed -E \
      -e 's/^(subscription_id[[:space:]]*=[[:space:]]*)"[^"]*"/\1"00000000-0000-0000-0000-000000000000"/' \
      -e 's/^(suffix[[:space:]]*=[[:space:]]*)"[^"]*"/\1"0000"/' \
      -e 's/^(storage_account_name[[:space:]]*=[[:space:]]*)"[^"]*"/\1"stbbmtfstate0000"/' \
      -e 's/^((admin|power_operator|secret_officer_user|secret_officer_sp)_object_ids[[:space:]]*=[[:space:]]*)\[[^]]*\]/\1[]/' \
      -e 's/^((preregistered_resource_providers|github_reviewer_ids)[[:space:]]*=[[:space:]]*)\[[^]]*\]/\1[]/' \
      -e 's/^(alert_emails[[:space:]]*=[[:space:]]*)\[[^]]*\]/\1["bbm-admins@example.com"]/' \
      -e 's/^((ephemeral|preview)_ci_principal_id[[:space:]]*=[[:space:]]*)"[^"]*"/\1null/' \
      -e 's/^(dns_zone_name[[:space:]]*=[[:space:]]*)"[^"]*"/\1""/' \
      "$f" >"$f.tmp"
    cat "$f.tmp" >"$f"
    rm -f "$f.tmp"
  done < <(find "$1/envs" -name '*.tfvars' -o -name 'backend*.hcl')
}

# ---------------------------------------------------------------------------
echo "== common.sh helpers"
TREE="$T/tree"
make_tree "$TREE"
BASE="$T/tree-base" # pristine copy to diff against
make_tree "$BASE"
export BBM_TF_ROOT="$TREE" BBM_REPO_ROOT="$repo" NO_COLOR=1
# shellcheck source-path=SCRIPTDIR source=common.sh
source "$here/common.sh"
set +e # checks handle failures themselves
B="$TREE/envs/global/bootstrap.tfvars"
G="$TREE/envs/global/global.tfvars"
D="$TREE/envs/staging/data.tfvars"
C="$TREE/envs/prod/compute.tfvars"

eq "get string" "$(tfvars_get_string "$B" location)" "northcentralus"
eq "get list" "$(tfvars_get "$B" admin_object_ids)" "[]"
check_fails "get missing key dies" tfvars_get "$B" no_such_key
check_fails "get multi-line value dies" tfvars_get "$D" subnet_cidrs

tfvars_set "$B" subscription_id '"11111111-2222-3333-4444-555555555555"' 2>/dev/null
eq "set value" "$(tfvars_get_string "$B" subscription_id)" "11111111-2222-3333-4444-555555555555"
tfvars_set "$D" suffix '"ab12"' 2>/dev/null
eq "set keeps trailing comment" "$(grep '^suffix' "$D")" 'suffix          = "ab12" # bootstrap output: suffix (same as envs/global/global.tfvars)'
eq "set leaves other lines alone" "$(diff "$BASE/envs/staging/data.tfvars" "$D" | grep -c '^[<>]')" "2"
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
preview_ci_principal_id = "dddddddd-0000-0000-0000-000000000000"
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
eq "reset: global preview principal" "$(tfvars_get "$RG_" preview_ci_principal_id)" "null"
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
  "$(cd "$BASE/envs" && find . -name 'backend*.hcl' | sort | xargs cat | cksum)"
eq "reset: keeps dns_zone_name" "$(tfvars_get_string "$RB" dns_zone_name)" "bbm.example.com"
eq "reset: keeps hint dns_zone_name" "$(tfvars_get_string "$RG_" dns_zone_name)" "bbm.example.com"
eq "reset: keeps alert_emails" "$(tfvars_get "$RB" alert_emails)" '["me@uni.edu"]'
eq "reset: keeps github_reviewer_ids" "$(tfvars_get "$RB" github_reviewer_ids)" "[12345]"
eq "reset: keeps home and env regions" \
  "$(tfvars_get_string "$RB" location)/$(tfvars_get_string "$RT/envs/staging/data.tfvars" location_abbr)/$(tfvars_get_string "$RT/envs/prod/compute.tfvars" location)" \
  "northcentralus/frc/canadacentral"
eq "reset: keeps env_locations" "$(grep -A4 '^env_locations' "$RB" | cksum)" "$(grep -A4 '^env_locations' "$BASE/envs/global/bootstrap.tfvars" | cksum)"
if grep -qE '^bbm: set .*/envs/global/bootstrap.tfvars: admin_object_ids = \[\]$' <<<"$reset_out"; then
  ok_ "reset: prints what it reset"
else
  bad "reset: prints what it reset"
fi
if [[ -n "$real_terraform" ]]; then
  check "reset tfvars pass terraform fmt -check" terraform fmt -check -recursive "$RT/envs"
fi
BBM_TF_ROOT="$TREE"

# region map (parsed from modules/naming/main.tf), validation, home / env regions
for pair in northcentralus=ncus canadacentral=cac francecentral=frc eastus2=eus2 centralus=cus; do
  eq "region_abbr ${pair%%=*}" "$(region_abbr "${pair%%=*}")" "${pair#*=}"
done
check_fails "region_abbr unknown region" region_abbr swedencentral
eq "resolve: map" "$(resolve_location_abbr canadacentral)" "cac"
eq "resolve: explicit abbr for unknown region" "$(resolve_location_abbr swedencentral sdc)" "sdc"
eq "resolve: explicit abbr matching the map" "$(resolve_location_abbr northcentralus ncus)" "ncus"
check_fails "resolve: unknown region without abbr dies" resolve_location_abbr swedencentral
check_fails "resolve: abbr not matching the map dies" resolve_location_abbr northcentralus eus2
check_fails "resolve: bad abbr dies" resolve_location_abbr swedencentral Sweden-1
check_fails "resolve: bad region name dies" resolve_location_abbr "North Central US"

# fixture regions (pin_fixture_regions): one per env (ADR 0002 section 8)
eq "fixture: home region" "$(tfvars_get_string "$B" location)/$(tfvars_get_string "$G" location_abbr)" "northcentralus/ncus"
for pair in test=northcentralus/ncus staging=francecentral/frc prod=canadacentral/cac; do
  e=${pair%%=*}
  eq "fixture: $e region (data + compute)" \
    "$(tfvars_get_string "$TREE/envs/$e/data.tfvars" location)/$(tfvars_get_string "$TREE/envs/$e/compute.tfvars" location_abbr)" "${pair#*=}"
  eq "env_region $e" "$(env_region "$e" | tr ' ' /)" "${pair#*=}"
done
eq "fixture: env_locations matches the env tfvars (bootstrap)" \
  "$(grep -A4 '^env_locations' "$B")" "$(env_locations_block)"
eq "fixture: env_locations matches the env tfvars (global)" \
  "$(grep -A4 '^env_locations' "$G")" "$(env_locations_block)"
# repo: the real envs/** layout must agree with itself, whatever regions it uses
for e in test staging prod; do
  rd="$repo/infra/terraform/envs/$e/data.tfvars" rc="$repo/infra/terraform/envs/$e/compute.tfvars"
  eq "repo: $e data and compute share a region" \
    "$(tfvars_get_string "$rd" location)/$(tfvars_get_string "$rd" location_abbr)" \
    "$(tfvars_get_string "$rc" location)/$(tfvars_get_string "$rc" location_abbr)"
  for gf in bootstrap global; do
    eq "repo: env_locations ($gf) lists $e in its region" \
      "$(grep -E "^[[:space:]]+${e}[[:space:]]*=" "$repo/infra/terraform/envs/global/$gf.tfvars" | grep -oE 'location = "[^"]*"' | head -1)" \
      "location = \"$(tfvars_get_string "$rd" location)\""
  done
done
for e in test staging prod; do
  eq "env-region.sh $e = env_region" "$("$TREE/scripts/env-region.sh" "$e" --get abbr)" "$(env_region "$e" | awk '{print $2}')"
done
eq "env-region.sh names" "$("$TREE/scripts/env-region.sh" prod | tr '\n' ' ')" \
  "BBM_LOCATION=canadacentral BBM_REGION_ABBR=cac DATA_RG=rg-bbm-prod-data-cac COMPUTE_RG=rg-bbm-prod-compute-cac CLUSTER=aks-bbm-prod-cac "
eq "env-region.sh global" "$("$TREE/scripts/env-region.sh" global | tr '\n' ' ')" \
  "BBM_LOCATION=northcentralus BBM_REGION_ABBR=ncus SHARED_RG=rg-bbm-shared-ncus TFSTATE_RG=rg-bbm-tfstate-ncus "
check "env-region.sh --check: matching Environment vars" env BBM_LOCATION=francecentral BBM_REGION_ABBR=frc "$TREE/scripts/env-region.sh" staging --check
check_fails "env-region.sh --check: stale Environment vars" env BBM_REGION_ABBR=ncus "$TREE/scripts/env-region.sh" staging --check
check_fails "env-region.sh: unknown env" "$TREE/scripts/env-region.sh" dev

SR="$T/tree-region"
make_tree "$SR"
BBM_TF_ROOT="$SR"
set_home_region canadacentral cac 2>/dev/null
eq "set_home_region: bootstrap + global" \
  "$(tfvars_get_string "$SR/envs/global/bootstrap.tfvars" location_abbr)/$(tfvars_get_string "$SR/envs/global/global.tfvars" location)" "cac/canadacentral"
eq "set_home_region: backend state RGs" \
  "$(grep -h '^resource_group_name' "$SR"/envs/*/backend*.hcl | sort -u | tr -s ' ')" 'resource_group_name = "rg-bbm-tfstate-cac"'
eq "set_home_region: env regions untouched" "$(env_region staging)" "francecentral frc"
set_env_region staging denmarkeast dke 2>/dev/null
eq "set_env_region: data + compute" \
  "$(tfvars_get_string "$SR/envs/staging/data.tfvars" location)/$(tfvars_get_string "$SR/envs/staging/compute.tfvars" location_abbr)" "denmarkeast/dke"
eq "set_env_region: other envs untouched" "$(env_region prod)/$(env_region test)" "canadacentral cac/northcentralus ncus"
sync_env_locations 2>/dev/null
eq "sync_env_locations: bootstrap map follows the env tfvars" \
  "$(grep -E '^  staging' "$SR/envs/global/bootstrap.tfvars" | tr -s ' ')" ' staging = { location = "denmarkeast", location_abbr = "dke" }'
eq "sync_env_locations: global map follows the env tfvars" "$(grep -A4 '^env_locations' "$SR/envs/global/global.tfvars")" "$(env_locations_block)"
sync_env_locations prod=belgiumcentral:bec 2>/dev/null
eq "sync_env_locations: explicit value wins" "$(grep -cF 'prod    = { location = "belgiumcentral", location_abbr = "bec" }' "$SR/envs/global/global.tfvars")" "1"
before=$(cat "$SR/envs/global/global.tfvars")
sync_env_locations prod=belgiumcentral:bec 2>/dev/null
eq "sync_env_locations: idempotent" "$(cat "$SR/envs/global/global.tfvars")" "$before"
check "sync_env_locations: no duplicate keys" tfvars_check_dupes "$SR/envs/global/global.tfvars"
eq "sync_env_locations: home location untouched" "$(tfvars_get_string "$SR/envs/global/global.tfvars" location)" "canadacentral"
if [[ -n "$real_terraform" ]]; then
  tf_fmt -recursive "$SR/envs"
  check "region tfvars pass terraform fmt -check" terraform fmt -check -recursive "$SR/envs"
fi
printf 'env_locations = {\n  test = {}\n' >"$T/open.tfvars"
check_fails "tfvars_replace_map: unclosed block dies" tfvars_replace_map "$T/open.tfvars" env_locations "$T/open.tfvars"
printf 'x = 1\n' >"$T/nomap.tfvars"
check_fails "tfvars_replace_map: missing block dies" tfvars_replace_map "$T/nomap.tfvars" env_locations "$T/open.tfvars"
sed '/^location_abbr/d' "$SR/envs/test/compute.tfvars" >"$T/c.tmp" && cat "$T/c.tmp" >"$SR/envs/test/compute.tfvars"
check_fails "set_env_region: compute.tfvars without location_abbr dies" set_env_region test canadacentral cac
BBM_TF_ROOT="$TREE"

# allowed_locations_json with a stubbed az (the subscription's policy assignments)
az() { printf '%s' "$AZ_POLICY_OUT"; }
S1=/subscriptions/11111111-2222-3333-4444-555555555555
AZ_POLICY_OUT='[{"scope":"'$S1'","locs":["francecentral","belgiumcentral","denmarkeast","northcentralus","canadacentral"]}]'
eq "allowed: student policy" "$(allowed_locations_json 11111111-2222-3333-4444-555555555555)" \
  '["belgiumcentral","canadacentral","denmarkeast","francecentral","northcentralus"]'
AZ_POLICY_OUT='[{"scope":"'$S1'","locs":["northcentralus","canadacentral","global"]},{"scope":"/providers/Microsoft.Management/managementGroups/mg1","locs":["CanadaCentral","eastus2","global"]},{"scope":"'$S1'/resourceGroups/rg1","locs":["eastus2"]}]'
eq "allowed: intersection, management group inherited, RG scope ignored" \
  "$(allowed_locations_json 11111111-2222-3333-4444-555555555555)" '["canadacentral","global"]'
AZ_POLICY_OUT='[]'
eq "allowed: no assignment → null" "$(allowed_locations_json 11111111-2222-3333-4444-555555555555)" "null"
# shellcheck disable=SC2317 # stub, called by allowed_locations_json
az() { return 1; }
check_fails "allowed: az failure is reported" allowed_locations_json 11111111-2222-3333-4444-555555555555
unset -f az

# shellcheck disable=SC2034 # read by common.sh
DRY_RUN=1
before=$(cat "$B")
tfvars_set "$B" location '"canadacentral"' 2>/dev/null
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
  "account list-locations")
    loc=$(sed -nE "s/.*name=='([a-z0-9]+)'.*/\1/p" <<<"$q")
    case "$loc" in
      canadacentral | francecentral | eastus2) echo "{\"name\":\"$loc\",\"availabilityZoneMappings\":[{\"logicalZone\":\"1\"}]}" ;;
      northcentralus | swedencentral | denmarkeast) echo "{\"name\":\"$loc\"}" ;;
      *) ;;
    esac ;;
  "policy assignment")
    # Azure for Students: "Allowed resource deployment regions" on the subscription
    def='[{"scope":"/subscriptions/11111111-2222-3333-4444-555555555555","locs":["francecentral","belgiumcentral","denmarkeast","northcentralus","canadacentral"]}]'
    echo "${BBM_TEST_POLICY:-$def}" ;;
  "provider show") echo "${BBM_TEST_COMPUTE_STATE:-Registered}" ;;
  "provider register") ;;
  "ad signed-in-user") echo "aaaaaaaa-0000-0000-0000-000000000001" ;;
  "role assignment") echo 1 ;;
  "provider list") printf 'Microsoft.Network\nMicrosoft.Storage\nMicrosoft.Web\n' ;;
  "group exists")
    n=""; prev=""
    for a in "$@"; do [[ "$prev" == -n ]] && n=$a; prev=$a; done
    if [[ -n "$n" && "$n" == "${BBM_TEST_GROUP_EXISTS:-}" ]]; then echo true; else echo false; fi ;;
  "storage account") echo "stbbmtfstateab12" ;;
  "group list")
    # only the groups whose name starts with the queried prefix
    pfx=$(sed -nE "s/.*starts_with\(name, '([^']+)'\).*/\1/p" <<<"$q")
    for g in ${BBM_TEST_GROUPS:-}; do [[ "$g" == "$pfx"* ]] && echo "$g"; done ;;
  "resource list") echo "${BBM_TEST_RESOURCES:-0}" ;;
  "vm list-skus")
    size=""; prev=""
    for a in "$@"; do [[ "$prev" == --size ]] && size=$a; prev=$a; done
    def='[{"name":"'$size'","family":"standardBASv2Family","capabilities":[{"name":"vCPUs","value":"4"}],"restrictions":[{"type":"Zone","reasonCode":"NotAvailableForSubscription"}]}]'
    echo "${BBM_TEST_SKUS:-$def}" ;;
  "vm list-usage")
    def='[{"name":{"value":"cores"},"currentValue":0,"limit":10},{"name":{"value":"standardBASv2Family"},"currentValue":0,"limit":2}]'
    echo "${BBM_TEST_USAGE:-$def}" ;;
  "postgres flexible-server") echo '[{"supportedServerEditions":[{"name":"Burstable","supportedServerSkus":[{"name":"Standard_B1ms"}]}]}]' ;;
  "aks get-versions") echo '{"values":[{"version":"1.32","isPreview":null},{"version":"1.33","isPreview":null,"isDefault":true},{"version":"1.35","isPreview":true}]}' ;;
  "keyvault list-deleted") printf 'kv-bbm-stg-ab12\tnorthcentralus\nkv-bbm-shared-ab12\tnorthcentralus\nkv-bbm-stg-zz99\tnorthcentralus\nkv-bbm-prd-ab12\tnorthcentralus\n' ;;
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
      tfstate_resource_group) printf rg-bbm-tfstate-ncus ;;
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
# No network: anything that would reach the internet is a failing shim
# (asserted unused at the end), so the suite runs on an offline runner.
for t in curl dig nslookup wget; do
  # shellcheck disable=SC2016
  printf '#!/usr/bin/env bash\necho "NETWORK %s $*" >>"$BBM_TEST_LOG.net"\nexit 1\n' "$t" >"$SHIM/$t"
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
hasnt_log() { if grep -qE -- "$2" "$LOG"; then bad "$1"; else ok_ "$1"; fi; }
hasnt_out() { if grep -qF -- "$2" <<<"$out"; then bad "$1 (unexpected: $2)"; else ok_ "$1"; fi; }
has "up: would write dns_zone_name" 'envs/global/bootstrap.tfvars: dns_zone_name = "bbm.example.com"'
has "up: admin id added" 'admin_object_ids = ["aaaaaaaa-0000-0000-0000-000000000001"]'
has "up: preregistered = registered ∩ bootstrap list" 'preregistered_resource_providers = ["Microsoft.Network", "Microsoft.Storage"]'
has "up: alert email defaulted" 'alert_emails = ["me@uni.edu"]'
has "up: reviewer from gh user" 'github_reviewer_ids = [12345]'
has "up: BASv2 quota warning per region" 'standardBASv2Family has only 2 vCPUs free in northcentralus, 4 needed'
has "up: each region's quota against its own needs" 'vCPU cores in francecentral: 0 used of 10 (staging add 4)'
has "up: prod quota in its region" 'vCPU standardBASv2Family in canadacentral: 0 used of 2 (prod add 4)'
has "up: node size checked per env region" 'env staging: Standard_B4as_v2 (4 vCPU, standardBASv2Family) is offered in francecentral'
has "up: PG checked in the staging region" 'PostgreSQL Flexible Standard_B1ms is offered in francecentral'
has "up: AKS versions per env region" 'AKS GA minors in canadacentral'
has "up: env regions from the env tfvars" 'env prod: canadacentral (names use cac)'
has "up: zones per env region" 'env staging: francecentral has availability zones: ingress_pip_zones = ["1", "2", "3"]'
has "up: all env regions checked against the policy" 'region canadacentral is allowed by the subscription'
has "up: env_locations synced" 'envs/global/bootstrap.tfvars: env_locations'
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
has "up: home region from bootstrap.tfvars" 'home region: northcentralus (tfstate and shared names use ncus)'
has "up: allowed-locations policy checked" 'region northcentralus is allowed by the subscription'
has "up: no zones in northcentralus → ingress_pip_zones = []" 'env test: northcentralus has no availability zones: ingress_pip_zones = []'
if grep -qF 'filled in for subscription' <<<"$out"; then bad "up: no tenant warning on placeholder"; else ok_ "up: no tenant warning on placeholder"; fi
eq "up: dry-run left the tree untouched" "$(snapshot)" "$snap0"
mut=$(grep -E '^az .*(import|secret set|purge|create|delete( |$)| update| register)|^gh (variable|api -X)|^terraform .*(apply|destroy|init|plan)|^(kubectl|kubelogin|helm) ' "$LOG" || true)
eq "up: no mutating CLI calls" "$mut" ""

# --location: the home region only (bootstrap, global, backends); env tfvars keep theirs
: >"$LOG"
TREE4="$T/tree4"
make_tree "$TREE4"
if RUN_TREE="$TREE4" run_script up.sh --subscription "$SUB" --zone bbm.example.com --location canadacentral --yes --dry-run; then
  ok_ "up --location canadacentral --dry-run exits 0"
else
  bad "up --location canadacentral --dry-run exits 0"
  sed 's/^/      /' "$T/out"
fi
out=$(cat "$T/out")
has "up --location: home region resolved from the map" 'home region: canadacentral (tfstate and shared names use cac)'
for f in global/bootstrap.tfvars global/global.tfvars; do
  has "up --location: $f location" "envs/$f: location = \"canadacentral\" (was \"northcentralus\")"
  has "up --location: $f location_abbr" "envs/$f: location_abbr = \"cac\" (was \"ncus\")"
done
for f in global/backend.hcl test/backend-data.hcl staging/backend-compute.hcl prod/backend-data.hcl; do
  has "up --location: $f state RG" "envs/$f: resource_group_name = \"rg-bbm-tfstate-cac\""
done
hasnt_out "up --location: env tfvars keep their regions" 'test/data.tfvars: location = "canadacentral"'
has "up --location: test stays in northcentralus" 'env test: northcentralus (names use ncus)'
check "up --location: state RG looked up in the new region" grep -qF 'az group exists -n rg-bbm-tfstate-cac' "$LOG"

# --env-location: one env's region, with its zones, quota and SKUs in that region
: >"$LOG"
if RUN_TREE="$TREE4" run_script up.sh --subscription "$SUB" --zone bbm.example.com --env-location staging=denmarkeast \
  --env-location prod=francecentral --prod --yes --dry-run; then
  ok_ "up --env-location --dry-run exits 0"
else
  bad "up --env-location --dry-run exits 0"
  sed 's/^/      /' "$T/out"
fi
out=$(cat "$T/out")
for f in staging/data.tfvars staging/compute.tfvars; do
  has "up --env-location: $f location" "envs/$f: location = \"denmarkeast\" (was \"francecentral\")"
  has "up --env-location: $f location_abbr" "envs/$f: location_abbr = \"dke\" (was \"frc\")"
done
has "up --env-location: prod moved too" 'envs/prod/data.tfvars: location_abbr = "frc" (was "cac")'
has "up --env-location: env_locations shows the new regions" 'staging = { location = "denmarkeast", location_abbr = "dke" }'
has "up --env-location: zones for the new region" 'staging/data.tfvars: ingress_pip_zones = [] (was ["1", "2", "3"])'
has "up --env-location: prod alone in francecentral" 'vCPU cores in francecentral: 0 used of 10 (prod add 4)'
has "up --env-location: home region untouched" "unchanged $TREE4/envs/global/bootstrap.tfvars: location = \"northcentralus\""
check "up --env-location: quota queried in denmarkeast" grep -qF 'az vm list-usage -l denmarkeast' "$LOG"
check "up --env-location: SKU queried in denmarkeast" grep -qF 'az vm list-skus -l denmarkeast --resource-type virtualMachines --size Standard_B4as_v2' "$LOG"
check "up --env-location: AKS versions in denmarkeast" grep -qF 'az aks get-versions -l denmarkeast' "$LOG"
check "up --env-location: policy checked for denmarkeast" grep -qF 'region denmarkeast is allowed' "$T/out"

# all=: collapse every env into one region (a bigger subscription); one region's quota covers all three
if RUN_TREE="$TREE4" run_script up.sh --subscription "$SUB" --zone bbm.example.com --env-location all=northcentralus --prod --yes --dry-run; then
  ok_ "up --env-location all= --dry-run exits 0"
else
  bad "up --env-location all= --dry-run exits 0"
  sed 's/^/      /' "$T/out"
fi
out=$(cat "$T/out")
has "up --env-location all=: summed need in one region" 'vCPU cores in northcentralus: 0 used of 10 (test,staging,prod add 12)'
has "up --env-location all=: regional quota warning" 'cores has only 10 vCPUs free in northcentralus, 12 needed'
check_fails "up --env-location: unknown env dies" run_script up.sh --subscription "$SUB" --env-location dev=francecentral --dry-run
check_fails "up --env-location: missing region dies" run_script up.sh --subscription "$SUB" --env-location staging --dry-run

# node size not offered / restricted in an env's region: fail before bootstrap
export BBM_TEST_SKUS='[]'
RUN_TREE="$TREE4" run_script up.sh --subscription "$SUB" --zone bbm.example.com --yes --dry-run || true
out=$(cat "$T/out")
has "up: node size not offered dies" 'env test: Standard_B4as_v2 is not offered in northcentralus'
export BBM_TEST_SKUS='[{"name":"Standard_B4as_v2","family":"standardBASv2Family","capabilities":[{"name":"vCPUs","value":"4"}],"restrictions":[{"type":"Location","reasonCode":"NotAvailableForSubscription"}]}]'
: >"$LOG"
RUN_TREE="$TREE4" run_script up.sh --subscription "$SUB" --zone bbm.example.com --yes --dry-run || true
out=$(cat "$T/out")
has "up: restricted node size dies" 'is restricted for this subscription in northcentralus (NotAvailableForSubscription)'
hasnt_log "up: SKU refusal stops before any terraform" '^terraform .*(init|plan|output)'
unset BBM_TEST_SKUS

# moving an env: only when its old-region RGs hold nothing but DNS zones
export BBM_TEST_GROUPS="rg-bbm-staging-data-ncus rg-bbm-staging-compute-ncus rg-bbm-test-data-ncus"
RUN_TREE="$TREE4" run_script up.sh --subscription "$SUB" --zone bbm.example.com --yes --dry-run || true
out=$(cat "$T/out")
has "up: empty old-region env RG is moved by bootstrap" 'env staging: rg-bbm-staging-data-ncus (old region) is empty but for DNS zones; bootstrap recreates it as rg-bbm-staging-data-frc'
hasnt_out "up: env in its current region is not flagged" 'rg-bbm-test-data-ncus (old region)'
export BBM_TEST_RESOURCES=3
RUN_TREE="$TREE4" run_script up.sh --subscription "$SUB" --zone bbm.example.com --yes --dry-run || true
out=$(cat "$T/out")
has "up: env with resources in its old region dies" 'env staging moves to francecentral but rg-bbm-staging-data-ncus still holds 3 resource(s): run infra/down.sh --envs staging first'
unset BBM_TEST_RESOURCES
export BBM_TEST_GROUPS="rg-bbm-prod-aksnodes-ncus"
RUN_TREE="$TREE4" run_script up.sh --subscription "$SUB" --zone bbm.example.com --yes --dry-run --prod || true
out=$(cat "$T/out")
has "up: env with a cluster in its old region dies" 'env prod still has a cluster in another region (rg-bbm-prod-aksnodes-ncus)'
unset BBM_TEST_GROUPS

# --location outside the subscription's allowed-locations policy fails early
: >"$LOG"
if RUN_TREE="$TREE4" run_script up.sh --subscription "$SUB" --zone bbm.example.com --location eastus2 --yes --dry-run; then
  bad "up --location eastus2 (not allowed) dies"
else
  ok_ "up --location eastus2 (not allowed) dies"
fi
out=$(cat "$T/out")
has "up: policy refusal lists the allowed regions" 'region eastus2 is not allowed by this subscription'"'"'s allowed-locations policy. Allowed: belgiumcentral, canadacentral, denmarkeast, francecentral, northcentralus'
hasnt_log "up: policy refusal stops before any terraform" '^terraform .*(init|plan|output)'

export BBM_TEST_POLICY='[]'
RUN_TREE="$TREE4" run_script up.sh --subscription "$SUB" --zone bbm.example.com --location swedencentral --yes --dry-run || true
out=$(cat "$T/out")
has "up: unknown region without --location-abbr dies" 'region swedencentral has no abbreviation in modules/naming/main.tf'
if RUN_TREE="$TREE4" run_script up.sh --subscription "$SUB" --zone bbm.example.com --location swedencentral --location-abbr sdc --yes --dry-run; then
  ok_ "up: unknown region with --location-abbr exits 0"
else
  bad "up: unknown region with --location-abbr exits 0"
  sed 's/^/      /' "$T/out"
fi
out=$(cat "$T/out")
has "up: no policy → no restriction" 'no allowed-locations policy assignment on the subscription'
has "up: explicit abbreviation written" 'location_abbr = "sdc"'
unset BBM_TEST_POLICY
RUN_TREE="$TREE4" run_script up.sh --subscription "$SUB" --zone bbm.example.com --location atlantis --yes --dry-run || true
out=$(cat "$T/out")
has "up: nonexistent region dies" "region 'atlantis' is not available to this subscription"

# an existing deployment in the old region blocks --location
export BBM_TEST_GROUP_EXISTS=rg-bbm-tfstate-ncus
RUN_TREE="$TREE4" run_script up.sh --subscription "$SUB" --zone bbm.example.com --location francecentral --yes --dry-run || true
out=$(cat "$T/out")
has "up: refuses to move a live deployment" 'a deployment still exists in northcentralus (rg-bbm-tfstate-ncus): run infra/down.sh --all first'
unset BBM_TEST_GROUP_EXISTS

# Microsoft.Compute not registered yet: register early, explain empty quota
: >"$LOG"
export BBM_TEST_COMPUTE_STATE=NotRegistered BBM_TEST_USAGE='[]'
if RUN_TREE="$TREE4" run_script up.sh --subscription "$SUB" --zone bbm.example.com --yes --dry-run; then
  ok_ "up: unregistered Microsoft.Compute --dry-run exits 0"
else
  bad "up: unregistered Microsoft.Compute --dry-run exits 0"
  sed 's/^/      /' "$T/out"
fi
out=$(cat "$T/out")
has "up: registers Microsoft.Compute early" 'az provider register -n Microsoft.Compute --wait'
has "up: quota unknown message" 'vCPU quota in northcentralus unknown until Microsoft.Compute is registered (bootstrap registers it); re-run up.sh after bootstrap to see it'
hasnt_log "up: dry run does not register providers" '^az provider register'
unset BBM_TEST_COMPUTE_STATE BBM_TEST_USAGE

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
  BBM_TF_ROOT="$TREE2" tfvars_set "$TREE2/envs/global/global.tfvars" suffix '"ab12"'
  for e in test staging prod; do
    BBM_TF_ROOT="$TREE2" tfvars_set "$TREE2/envs/$e/data.tfvars" suffix '"ab12"'
  done
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
has "down: purge vault" 'az keyvault purge -n kv-bbm-stg-ab12 -l northcentralus'
has "down --all: purge shared vault" 'az keyvault purge -n kv-bbm-shared-ab12 -l northcentralus'
has "down --all: purge prod vault" 'az keyvault purge -n kv-bbm-prd-ab12 -l northcentralus'
hasnt() { if grep -qF -- "$2" <<<"$out"; then bad "$1 (unexpected: $2)"; else ok_ "$1"; fi; }
hasnt "down --all: other tenant's/suffix's vault kept" 'kv-bbm-stg-zz99'
has "down --all: prod confirmation noted in dry run" "a real run asks you to type 'prod'"
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

# --envs: purge only the destroyed envs' vaults (never the shared one)
if run_script down.sh --subscription "$SUB" --envs staging --yes --dry-run; then
  ok_ "down --envs staging --dry-run exits 0"
else
  bad "down --envs staging --dry-run exits 0"
  sed 's/^/      /' "$T/out"
fi
out=$(cat "$T/out")
has "down --envs staging: purges its vault" 'az keyvault purge -n kv-bbm-stg-ab12 -l northcentralus'
hasnt "down --envs staging: keeps the shared vault" 'purge -n kv-bbm-shared-ab12'
hasnt "down --envs staging: keeps prod's vault" 'purge -n kv-bbm-prd-ab12'
hasnt "down --envs staging: keeps other suffixes" 'purge -n kv-bbm-stg-zz99'
hasnt "down --envs staging: no prod confirmation" "type 'prod'"
run_script down.sh --subscription "$SUB" --envs test --yes --dry-run || true
out=$(cat "$T/out")
hasnt "down --envs test: purges no other env's vault" 'az keyvault purge'

# prod: --yes alone never skips typing `prod`
run_script down.sh --subscription "$SUB" --envs prod --yes --yes-really-destroy-prod --dry-run || true
out=$(cat "$T/out")
has "down prod: --yes-really-destroy-prod skips the prod prompt" 'prod confirmation skipped (--yes --yes-really-destroy-prod)'
if setsid -w true 2>/dev/null; then # no controlling terminal: --yes without the prod flag must refuse
  : >"$LOG"
  for envs in prod staging,prod; do
    if RUN_WRAP="setsid -w" run_script down.sh --subscription "$SUB" --envs "$envs" --yes; then
      bad "down --envs $envs --yes without a tty dies"
    else
      ok_ "down --envs $envs --yes without a tty dies"
    fi
    if grep -qF 'pass --yes --yes-really-destroy-prod' "$T/out"; then ok_ "down --envs $envs: refusal explains"; else bad "down --envs $envs: refusal explains"; fi
  done
  if RUN_WRAP="setsid -w" run_script down.sh --subscription "$SUB" --all --yes; then
    bad "down --all --yes without a tty dies (prod)"
  else
    ok_ "down --all --yes without a tty dies (prod)"
  fi
  mut=$(grep -E '^terraform |^az .*(purge|delete( |$))|^gh ' "$LOG" || true)
  eq "down prod refusal: nothing ran" "$mut" ""
else
  echo "  skip prod no-tty checks (no setsid -w)"
fi

net_calls=$(cat "$LOG.net" 2>/dev/null || true)
eq "no network calls (curl/dig/nslookup/wget)" "$net_calls" ""

echo
echo "passed: $pass, failed: $failed"
[[ $failed -eq 0 ]]
