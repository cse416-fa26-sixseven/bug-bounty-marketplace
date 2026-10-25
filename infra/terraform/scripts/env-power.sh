#!/usr/bin/env bash
# On-demand power control for the AKS environments (test, staging, prod).
#
#   scripts/env-power.sh <env> <action> [--include-db true|false]
#
#   env      test | staging | prod   (test has no Postgres server: every Postgres
#                                     step is a no-op there)
#   action   status      AKS power/provisioning state, node pools, Postgres state,
#                        data RG tags, ingress host and GET /health
#            pause       az aks stop (+ Postgres stop with --include-db true), tag paused
#            resume      Postgres start, az aks start, tag running (idempotent: waits
#                        for a start already in flight, so concurrent callers are safe)
#            mark-down   tag power-state=down   (after terraform destroy of compute)
#            mark-up     tag power-state=running (after terraform apply of compute)
#            db-stop     stop Postgres only (used by `down`)
#            db-start    start Postgres only (used by `up`)
#            auto-pause  pause if the cluster is running and auto-pause != false (nightly)
#            repause-db  stop Postgres again if the env is paused/down but Azure
#                        auto-started it (7-day limit) (daily)
#
#   --include-db  pause/auto-pause: also stop Postgres (default true).
#                 resume always starts Postgres: the app cannot run without it.
#
# Uses only the az CLI (no terraform, no state access), so the reviewer-free
# prod-power identity (custom role "BBM Power Operator") can run pause/resume.
# Long-running operations use --no-wait and poll `az ... list`, so the role
# needs no operation-status permissions.
#
# Live state is stored as tags on rg-bbm-<env>-data-<region abbr>:
#   power-state=running|paused|down, auto-pause=true|false, db-paused=true|false,
#   <state>-at=<UTC timestamp>, bbm-last-deployed-tag=<image tag> (written by deploy.yml)
#
# Environment (optional):
#   BBM_REGION_ABBR, BBM_LOCATION  region abbreviation and name (default: location_abbr /
#                                  location in envs/<env>/data.tfvars)
#   ENV_POWER_TIMEOUT (seconds per wait, 1800)  ENV_POWER_POLL (seconds, 20)
#   GITHUB_STEP_SUMMARY / GITHUB_OUTPUT: when set (GitHub Actions), a markdown
#   summary and key=value outputs are appended.
#
# Exit codes: 0 ok (including no-op), 1 error, 2 usage,
#             3 refused (cluster busy, e.g. maintenance window), 4 env is down.
set -euo pipefail

die() {
  echo "env-power: $*" >&2
  exit 1
}

usage() {
  awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "${BASH_SOURCE[0]}" >&2
  exit 2
}

[[ $# -ge 2 ]] || usage
env=$1
action=$2
shift 2

include_db=true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --include-db)
      [[ $# -ge 2 ]] || usage
      include_db=$2
      shift 2
      ;;
    --include-db=*)
      include_db=${1#*=}
      shift
      ;;
    *) usage ;;
  esac
done

case "$env" in test | staging | prod) ;; *) die "env must be test, staging or prod (got '$env')" ;; esac
case "$include_db" in true | false) ;; *) die "--include-db must be true or false (got '$include_db')" ;; esac
case "$action" in
  status | pause | resume | mark-down | mark-up | db-stop | db-start | auto-pause | repause-db) ;;
  *) die "unknown action '$action'" ;;
esac

command -v az >/dev/null 2>&1 || die "az CLI not found on PATH"

# Region: BBM_LOCATION / BBM_REGION_ABBR when set (CI jobs bound to the env's
# GitHub Environment: its AZURE_LOCATION / AZURE_LOCATION_ABBR), else the env's
# own tfvars (envs/<env>/data.tfvars via env-region.sh): each env has its own
# region (ADR 0002 section 8).
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
abbr=${BBM_REGION_ABBR:-$("$here/env-region.sh" "$env" --get abbr)} || die "region of $env unknown"
location=${BBM_LOCATION:-$("$here/env-region.sh" "$env" --get location)} || die "region of $env unknown"
[[ -n "$abbr" && -n "$location" ]] || die "region unknown: set BBM_LOCATION and BBM_REGION_ABBR (or location/location_abbr in envs/$env/data.tfvars)"
timeout=${ENV_POWER_TIMEOUT:-1800}
poll=${ENV_POWER_POLL:-20}

data_rg="rg-bbm-$env-data-$abbr"
compute_rg="rg-bbm-$env-compute-$abbr"
cluster="aks-bbm-$env-$abbr"
pg="psql-bbm-$env-$abbr"
pip="pip-bbm-$env-ingress"
# The test env runs in-cluster Postgres per ephemeral namespace (ADR 0002).
has_pg=true
[[ "$env" == test ]] && has_pg=false

started_at=$(date +%s)

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { echo "[$(date -u +%H:%M:%S)] $*"; }

summary() {
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    printf '%s\n' "$@" >>"$GITHUB_STEP_SUMMARY"
  fi
}

output() {
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    printf '%s=%s\n' "$1" "$2" >>"$GITHUB_OUTPUT"
  fi
}

# ---- reads -----------------------------------------------------------------

# "<powerState> <provisioningState>", or empty when the cluster does not exist.
# `list` (not `show`) so "not found" is an empty result, never a parsed error.
aks_state() {
  az aks list -g "$compute_rg" \
    --query "[?name=='$cluster'] | [0].join(' ', [powerState.code, provisioningState])" -o tsv
}

aks_pools() {
  az aks list -g "$compute_rg" \
    --query "[?name=='$cluster'] | [0].agentPoolProfiles[].join(' ', [name, to_string(count), powerState.code])" \
    -o tsv | awk '{ printf "%s%s=%s(%s)", (NR > 1 ? ", " : ""), $1, $2, $3 }'
}

# Ready | Stopped | Starting | Stopping | Updating | ..., or empty when missing.
pg_state() {
  $has_pg || return 0
  az postgres flexible-server list -g "$data_rg" --query "[?name=='$pg'] | [0].state" -o tsv
}

tag() {
  az group show -n "$data_rg" --query "tags.\"$1\"" -o tsv
}

set_tags() {
  local rg_id
  rg_id=$(az group show -n "$data_rg" --query id -o tsv)
  az tag update --resource-id "$rg_id" --operation merge --tags "$@" -o none
  log "tagged $data_rg: $*"
}

# App host: the env's public DNS zone <env>.<zone> (ADR 0002), else the static
# IP's cloudapp FQDN. BBM Power Operator may be unable to read either; fall back
# to the fixed DNS label.
ingress_fqdn() {
  local fqdn
  fqdn=$(az network dns zone list -g "$data_rg" --query "[?starts_with(name, '$env.')] | [0].name" -o tsv 2>/dev/null || true)
  [[ -n "$fqdn" ]] ||
    fqdn=$(az network public-ip show -g "$data_rg" -n "$pip" --query dnsSettings.fqdn -o tsv 2>/dev/null || true)
  echo "${fqdn:-bbm-$env.$location.cloudapp.azure.com}"
}

# "https://<host>" or "http://<host>" (whichever answers /health), else "unreachable".
# The test env serves no app at its apex (only ephemeral namespaces): "n/a".
health() {
  local scheme
  if [[ "$env" == test ]]; then
    echo "n/a"
    return 0
  fi
  command -v curl >/dev/null 2>&1 || {
    echo "unreachable"
    return 0
  }
  for scheme in https http; do
    if curl -fsS -m 5 -o /dev/null "$scheme://$1/health" 2>/dev/null; then
      echo "$scheme://$1"
      return 0
    fi
  done
  echo "unreachable"
}

# Prints the current state to stdout (and the step summary) under heading $1.
snapshot() {
  local heading=$1 aks power prov pools pgs ps ap lt fqdn h
  aks=$(aks_state)
  if [[ -n "$aks" ]]; then
    read -r power prov <<<"$aks"
    pools=$(aks_pools)
  else
    power="NotFound"
    prov="-"
    pools="-"
  fi
  pgs=$(pg_state)
  $has_pg || pgs="None (in-cluster per namespace)"
  ps=$(tag power-state)
  ap=$(tag auto-pause)
  lt=$(tag bbm-last-deployed-tag)
  fqdn=$(ingress_fqdn)
  h=$(health "$fqdn")

  cat <<EOF
== $env: $heading ==
  AKS $cluster       power=$power provisioning=$prov
  node pools         ${pools:-none}
  Postgres $pg       ${pgs:-NotFound}
  tags               power-state=${ps:-unset} auto-pause=${ap:-unset} bbm-last-deployed-tag=${lt:-unset}
  ingress            $fqdn  /health=$h
EOF
  summary "#### $env: $heading" "" \
    "| | |" "|---|---|" \
    "| AKS \`$cluster\` | power **$power**, provisioning $prov |" \
    "| node pools | ${pools:-none} |" \
    "| Postgres \`$pg\` | ${pgs:-NotFound} |" \
    "| power-state tag | ${ps:-unset} |" \
    "| auto-pause tag | ${ap:-unset} |" \
    "| last deployed tag | ${lt:-unset} |" \
    "| ingress | $fqdn (\`/health\`: $h) |" ""
  output aks_power "$power"
  output aks_provisioning "$prov"
  output pg_state "$($has_pg && echo "${pgs:-NotFound}" || echo None)"
  output power_state "${ps:-}"
  output auto_pause "${ap:-}"
  output last_deployed_tag "${lt:-}"
  output fqdn "$fqdn"
  output url "https://$fqdn"
  output health "$h"
}

# ---- waits -----------------------------------------------------------------

# wait_for <description> <command producing a value> <expected value>
wait_for() {
  local what=$1 fn=$2 want=$3 got deadline
  deadline=$(($(date +%s) + timeout))
  while :; do
    got=$($fn)
    [[ "$got" == "$want" ]] && {
      log "$what: $got"
      return 0
    }
    (($(date +%s) < deadline)) || die "timed out after ${timeout}s waiting for $what (last: '${got:-none}', want '$want')"
    log "$what: ${got:-none} (waiting for $want)"
    sleep "$poll"
  done
}

# ---- Postgres --------------------------------------------------------------

db_stop() {
  local s
  if ! $has_pg; then
    log "$env has no Postgres server; nothing to stop"
    return 0
  fi
  s=$(pg_state)
  case "$s" in
    "") log "Postgres $pg not found; nothing to stop" ;;
    Stopped) log "Postgres already Stopped" ;;
    Stopping) wait_for "Postgres" pg_state Stopped ;;
    Starting)
      wait_for "Postgres" pg_state Ready
      db_stop
      return
      ;;
    Ready)
      log "stopping Postgres $pg"
      az postgres flexible-server stop -g "$data_rg" -n "$pg" --no-wait -o none
      wait_for "Postgres" pg_state Stopped
      ;;
    *) die "Postgres $pg is '$s'; cannot stop it now (retry later)" ;;
  esac
  set_tags db-paused=true
}

db_start() {
  local s
  if ! $has_pg; then
    log "$env has no Postgres server; nothing to start"
    return 0
  fi
  s=$(pg_state)
  case "$s" in
    "") die "Postgres $pg not found in $data_rg (data stack not applied?)" ;;
    Ready) log "Postgres already Ready" ;;
    Starting) wait_for "Postgres" pg_state Ready ;;
    Stopping)
      wait_for "Postgres" pg_state Stopped
      db_start
      return
      ;;
    Stopped)
      log "starting Postgres $pg"
      az postgres flexible-server start -g "$data_rg" -n "$pg" --no-wait -o none
      wait_for "Postgres" pg_state Ready
      ;;
    *) die "Postgres $pg is '$s'; cannot start it now (retry later)" ;;
  esac
  set_tags db-paused=false
}

# ---- actions ---------------------------------------------------------------

finish() {
  local secs=$(($(date +%s) - started_at))
  log "$action finished in ${secs}s"
  summary "_${action} took $((secs / 60))m $((secs % 60))s._" ""
  output elapsed_seconds "$secs"
}

do_pause() {
  local aks power prov
  aks=$(aks_state)
  if [[ -z "$aks" ]]; then
    log "cluster $cluster not found: $env is down (compute destroyed); nothing to stop"
    summary "Cluster not found: **$env is down**. Only Postgres is handled." ""
    [[ "$include_db" == true ]] && db_stop
    return 0
  fi
  read -r power prov <<<"$aks"
  if [[ "$power" == "Stopped" ]]; then
    log "cluster already Stopped"
  else
    if [[ "$prov" != "Succeeded" ]]; then
      echo "env-power: refusing to stop $cluster: provisioningState is '$prov', not 'Succeeded'." >&2
      echo "  The cluster is busy (an upgrade, a node image update in the Sunday 06:00-10:00 UTC" >&2
      echo "  maintenance window, a scale or a previous start/stop). Retry once it settles:" >&2
      echo "    az aks show -g $compute_rg -n $cluster --query provisioningState" >&2
      summary "**Refused:** \`$cluster\` provisioningState is \`$prov\` (maintenance window or another operation in progress). Retry later." ""
      exit 3
    fi
    log "stopping $cluster"
    az aks stop -g "$compute_rg" -n "$cluster" --no-wait -o none
    wait_for "AKS power/provisioning" aks_state "Stopped Succeeded"
  fi
  [[ "$include_db" == true ]] && db_stop
  local dbp=$include_db
  $has_pg || dbp=false
  set_tags power-state=paused "paused-at=$(now)" "db-paused=$dbp"
}

do_resume() {
  local aks power prov
  aks=$(aks_state)
  if [[ -z "$aks" ]]; then
    echo "env-power: cluster $cluster not found: $env is down. Use action 'up' (terraform apply + deploy) instead." >&2
    summary "**$env is down** (no cluster). Run env-power with action \`up\`." ""
    exit 4
  fi
  db_start
  read -r power prov <<<"$aks"
  if [[ "$prov" == "Stopping" ]]; then
    # A stop in flight (e.g. the nightly auto-pause) can still report power
    # Running; waiting for "Running Succeeded" would time out. Let the stop
    # finish, then start.
    log "a stop is in progress ($power/$prov): waiting for it to finish before starting"
    wait_for "AKS power/provisioning" aks_state "Stopped Succeeded"
    power=Stopped prov=Succeeded
  fi
  if [[ "$power" == "Running" || "$prov" == "Starting" ]]; then
    # Running, or a start already in flight (another caller): just wait.
    log "cluster is $power/$prov"
    [[ "$power $prov" == "Running Succeeded" ]] || wait_for "AKS power/provisioning" aks_state "Running Succeeded"
  else
    # A stop still in flight must settle before start is accepted.
    [[ "$prov" == "Succeeded" ]] || wait_for "AKS power/provisioning" aks_state "Stopped Succeeded"
    log "starting $cluster"
    if ! az aks start -g "$compute_rg" -n "$cluster" --no-wait -o none; then
      # Lost a race with a concurrent start: fine if one is now in flight.
      aks=$(aks_state)
      [[ "$aks" == "Running "* || "$aks" == *" Starting" ]] || die "az aks start failed (cluster is '${aks:-not found}')"
      log "a concurrent start is in flight ($aks)"
    fi
    wait_for "AKS power/provisioning" aks_state "Running Succeeded"
  fi
  set_tags power-state=running "resumed-at=$(now)"
}

do_auto_pause() {
  local ap aks
  ap=$(tag auto-pause)
  if [[ "$ap" == "false" ]]; then
    log "auto-pause=false on $data_rg: skipping"
    summary "auto-pause=false on \`$data_rg\`: skipped." ""
    return 0
  fi
  aks=$(aks_state)
  if [[ -z "$aks" || "$aks" == Stopped* ]]; then
    log "cluster is ${aks:-not found}: nothing to auto-pause"
    summary "Nothing to auto-pause (cluster ${aks:-not found})." ""
    return 0
  fi
  do_pause
}

do_repause_db() {
  local ps dbp s
  if ! $has_pg; then
    log "$env has no Postgres server; nothing to do"
    return 0
  fi
  ps=$(tag power-state)
  dbp=$(tag db-paused)
  s=$(pg_state)
  if [[ "$ps" != "paused" && "$ps" != "down" ]]; then
    log "power-state=${ps:-unset}: Postgres is meant to run; nothing to do"
    return 0
  fi
  if [[ "$dbp" == "false" ]]; then
    log "env paused with --include-db false: leaving Postgres as is"
    return 0
  fi
  if [[ "$s" == "Ready" ]]; then
    log "power-state=$ps but Postgres is Ready (Azure auto-starts after 7 days): stopping it"
    summary "Postgres was auto-started by Azure while $env is $ps: stopping it again." ""
    db_stop
  else
    log "Postgres is ${s:-not found}: nothing to do"
  fi
}

summary "### env-power \`$action\` on \`$env\`" ""

case "$action" in
  status)
    snapshot "status"
    ;;
  pause | auto-pause)
    snapshot "before"
    if [[ "$action" == pause ]]; then do_pause; else do_auto_pause; fi
    snapshot "after"
    summary "Paused: no node or Postgres compute billing. Still billed: disks, Postgres storage, the static public IP and load balancer, Key Vault, storage and logs." ""
    finish
    ;;
  resume)
    snapshot "before"
    do_resume
    snapshot "after"
    summary "Running: nodes and Postgres compute are billed again. Pause when done." ""
    finish
    ;;
  mark-down)
    set_tags power-state=down "down-at=$(now)"
    ;;
  mark-up)
    set_tags power-state=running "up-at=$(now)"
    ;;
  db-stop)
    db_stop
    finish
    ;;
  db-start)
    db_start
    finish
    ;;
  repause-db)
    do_repause_db
    finish
    ;;
esac
