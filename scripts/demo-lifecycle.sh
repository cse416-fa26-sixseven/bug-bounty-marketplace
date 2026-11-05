#!/usr/bin/env bash
# Full on-chain lifecycle against `pnpm stack:demo`, from the command line:
#   1. payout: upload -> analysis -> fund -> stake -> claim -> passing PoC -> Verified ->
#      paid after the challenge window -> the auditor withdraws;
#   2. dispute: a second bounty -> Verified -> the developer disputes -> the
#      arbiter rules against the auditor -> Rejected, stake slashed by half;
#      the auditor then withdraws what is left;
#   3. lapse: a third bounty -> Verified -> disputed -> the arbiter never rules
#      -> anvil's clock jumps past the ruling window -> the keeper lapses the
#      dispute -> Verified -> Paid. The jump is permanent: every later run (and
#      any other demo on the same stack) sees anvil's clock 3 days further ahead.
# Users sign their own transactions with anvil's dev accounts (cast, inside the
# contracts image) and sign in to the API with a signed SIWE message. Prints
# LIFECYCLE OK. Can run again on the same stack (it tops the stake back up).
# Needs curl (7.76+), jq and docker.
set -euo pipefail

API=${API:-http://localhost:3001}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
FIXTURES="$ROOT/workers/analysis/tests/fixtures"

# anvil dev accounts: local demo only.
ARB=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
ARB_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
DEV=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
DEV_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
AUD=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC
AUD_KEY=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a
ONE_ETH=1000000000000000000

step() { printf '\n== %s\n' "$*"; }
die() { printf 'LIFECYCLE FAILED: %s\n' "$*" >&2; exit 1; }
for tool in curl jq docker; do command -v "$tool" >/dev/null || die "$tool is required"; done

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# API call: prints the body; on an HTTP error prints the API's message to
# stderr (the body would otherwise vanish into the jq that reads stdout).
api() {
  local out
  if ! out=$(curl -sS --fail-with-body "$@"); then
    printf 'API error: %s\n' "$out" >&2
    return 1
  fi
  printf '%s\n' "$out"
}

# cast runs in the contracts image, on the compose network. Its stderr (revert
# reasons, compose errors) is shown only when it fails.
cast_in() {
  local out
  if ! out=$(docker compose run --rm --no-deps -T --entrypoint cast anvil "$@" 2>"$WORK/cast.err"); then
    cat "$WORK/cast.err" >&2
    return 1
  fi
  printf '%s\n' "$out"
}
cast_rpc() { cast_in "$@" --rpc-url http://anvil:8545; }
stake_of() { cast_rpc call "$STAKING" 'stakeOf(address)(uint256)' "$AUD" | awk '{print $1}'; }

CHAIN=$(api "$API/api/chain") || die "API not reachable at $API"
[ "$(jq -r .configured <<<"$CHAIN")" = "true" ] || die "the API has no chain: run pnpm stack:demo"
ESCROW=$(jq -r .addresses.bountyEscrow <<<"$CHAIN")
STAKING=$(jq -r .addresses.auditorStaking <<<"$CHAIN")
DISPUTES=$(jq -r .addresses.disputeResolution <<<"$CHAIN")
WINDOW=$(jq -r .challengeWindowSeconds <<<"$CHAIN")
REQUIRED_STAKE=$(jq -r .requiredStakeWei <<<"$CHAIN")

sign_in() { # key address jar
  local message signature
  message=$(api -H 'content-type: application/json' -d "{\"address\":\"$2\"}" "$API/api/auth/nonce" | jq -r .message) \
    || die "sign-in nonce failed for $2"
  signature=$(cast_in wallet sign --private-key "$1" "$message") || die "signing failed for $2"
  api -c "$3" -H 'content-type: application/json' \
    -d "$(jq -n --arg message "$message" --arg signature "$signature" '{$message, $signature}')" \
    "$API/api/auth/login" >/dev/null || die "sign-in failed for $2"
}

finding_status() { api "$API/api/contracts/$1/findings" | jq -r ".[] | select(.id==\"$2\") | .status"; }

wait_status() { # contract finding status seconds
  local now=""
  for _ in $(seq 1 "$4"); do
    now=$(finding_status "$1" "$2" 2>/dev/null) || true
    [ "$now" = "$3" ] && return 0
    sleep 1
  done
  die "finding $2 never reached $3 (last seen: ${now:-unknown})"
}

pending_payout() { api -b "$WORK/aud" "$API/api/auditor/profile" | jq -r .pendingPayout; }

wait_analysis() { # contract seconds: funding and claims wait for a finished analysis
  local status=""
  for _ in $(seq 1 "$2"); do
    status=$(api "$API/api/contracts/$1/analysis" 2>/dev/null | jq -r .status) || true
    [ "$status" = Done ] && return 0
    [ "$status" = Failed ] && die "analysis of $1 failed: $(api "$API/api/contracts/$1/analysis" | jq -r .error)"
    sleep 1
  done
  die "analysis of $1 not done after $2 seconds (last seen: ${status:-unknown})"
}

# Developer: upload, wait for the analysis, fund on-chain, confirm. Prints "contract finding".
funded_contract() {
  local contract onchain finding
  contract=$(api -b "$WORK/dev" -F "file=@$FIXTURES/Vault.sol" -F "bountyAmount=$ONE_ETH" \
    -F deadline=2030-01-01T00:00:00.000Z "$API/api/contracts" | jq -r .id) || die "upload failed"
  wait_analysis "$contract" 300
  onchain=$(cast_in keccak "$contract") || die "keccak failed"
  cast_rpc send --private-key "$DEV_KEY" --value 1ether "$ESCROW" "fund(bytes32,uint256)" "$onchain" 1893456000 >/dev/null \
    || die "fund failed"
  api -b "$WORK/dev" -X POST "$API/api/contracts/$contract/funded" >/dev/null || die "funded check failed"
  finding=$(api "$API/api/contracts/$contract/findings" \
    | jq -r '[.[] | select(.slitherDetector=="reentrancy-eth")][0].id // empty') || die "findings failed"
  [ -n "$finding" ] || die "no reentrancy finding for $contract"
  echo "$contract $finding"
}

# Auditor: claim and prove.
claim_and_prove() { # contract finding
  local status
  status=$(api -b "$WORK/aud" -H 'content-type: application/json' -d "{\"contractId\":\"$1\"}" \
    "$API/api/auditor/claim" | jq -r .status) || die "claim failed"
  [ "$status" = Claimed ] || die "claim returned $status"
  api -b "$WORK/aud" -F "findingId=$2" -F "file=@$FIXTURES/pocs/PoC_pass.t.sol" "$API/api/auditor/poc" >/dev/null \
    || die "PoC upload failed"
  wait_status "$1" "$2" Verified 180
}

step "Signing in as developer, auditor and arbiter"
sign_in "$DEV_KEY" "$DEV" "$WORK/dev"
sign_in "$AUD_KEY" "$AUD" "$WORK/aud"
sign_in "$ARB_KEY" "$ARB" "$WORK/arb"

step "Auditor stakes up to the required $REQUIRED_STAKE wei"
STAKE=$(stake_of) || die "reading the stake failed"
if [ "$STAKE" -lt "$REQUIRED_STAKE" ]; then
  cast_rpc send --private-key "$AUD_KEY" --value "$((REQUIRED_STAKE - STAKE))" "$STAKING" "stake()" >/dev/null \
    || die "stake failed"
fi
echo "profile: $(api -b "$WORK/aud" "$API/api/auditor/profile" | jq -c '{stake, reputation}')"

step "Payout: fund, prove, wait out the ${WINDOW}s challenge window"
OUT=$(funded_contract) || exit 1
read -r C1 F1 <<<"$OUT"
echo "contract $C1, reentrancy finding $F1"
PENDING_BEFORE=$(pending_payout) || die "reading the profile failed"
claim_and_prove "$C1" "$F1"
echo "finding Verified"
wait_status "$C1" "$F1" Paid $((WINDOW + 60))
PENDING=$(pending_payout) || die "reading the profile failed"
[ "$((PENDING - PENDING_BEFORE))" = "$ONE_ETH" ] || die "pending payout went $PENDING_BEFORE -> $PENDING, expected +1 ETH"
cast_rpc send --private-key "$AUD_KEY" "$ESCROW" "withdrawPayout()" >/dev/null || die "withdraw failed"
echo "finding Paid, contract $(api "$API/api/contracts/$C1" | jq -r .status), $(cast_in from-wei "$PENDING") ETH withdrawn"

step "Dispute: a second bounty, disputed and ruled against the auditor"
OUT=$(funded_contract) || exit 1
read -r C2 F2 <<<"$OUT"
echo "contract $C2, reentrancy finding $F2"
claim_and_prove "$C2" "$F2"
C2_ID=$(cast_in keccak "$C2") || die "keccak failed"
F2_ID=$(cast_in keccak "$F2") || die "keccak failed"
cast_rpc send --private-key "$DEV_KEY" "$DISPUTES" "openDispute(bytes32,bytes32,string)" \
  "$C2_ID" "$F2_ID" "The PoC is not a realistic attack" >/dev/null || die "openDispute failed"
DISPUTE=$(api -b "$WORK/dev" -H 'content-type: application/json' -d '{"reason":"The PoC is not a realistic attack"}' \
  "$API/api/findings/$F2/dispute" | jq -r .id) || die "dispute route failed"
wait_status "$C2" "$F2" Disputed 30
STAKE_BEFORE=$(stake_of) || die "reading the stake failed"
cast_rpc send --private-key "$ARB_KEY" "$DISPUTES" "rule(bytes32,bytes32,bool)" "$C2_ID" "$F2_ID" false >/dev/null \
  || die "rule failed"
RULING=$(api -b "$WORK/arb" -H 'content-type: application/json' -d '{"ruling":"AgainstAuditor"}' \
  "$API/api/arbiter/disputes/$DISPUTE/rule" | jq -r .ruling) || die "ruling route failed"
wait_status "$C2" "$F2" Rejected 30
STAKE_AFTER=$(stake_of) || die "reading the stake failed"
[ "$STAKE_AFTER" = "$((STAKE_BEFORE / 2))" ] || die "stake $STAKE_BEFORE -> $STAKE_AFTER, expected half"
echo "ruling $RULING, finding Rejected, stake $STAKE_BEFORE -> $STAKE_AFTER wei"

step "Auditor withdraws the remaining stake (no locks left)"
ACTIVE=$(api -b "$WORK/aud" "$API/api/auditor/profile" | jq -r .activeSubmissions) || die "profile failed"
[ "$ACTIVE" = "0" ] || die "auditor still holds $ACTIVE stake locks"
cast_rpc send --private-key "$AUD_KEY" "$STAKING" "withdraw(uint256)" "$STAKE_AFTER" >/dev/null \
  || die "stake withdraw failed"
[ "$(stake_of)" = "0" ] || die "stake not withdrawn"
echo "withdrew $STAKE_AFTER wei of stake"

# Lapse: a third bounty is disputed and the arbiter never rules. Anvil's clock
# is moved past DisputeResolution's 3-day ruling window; the API's payout
# keeper then lapses the dispute (in the auditor's favour) and pays out.
RULING_WINDOW=$((3 * 24 * 60 * 60))
step "Lapse: a third bounty, disputed, never ruled, lapsed by the keeper and paid"
cast_rpc send --private-key "$AUD_KEY" --value "$REQUIRED_STAKE" "$STAKING" "stake()" >/dev/null \
  || die "stake failed"
OUT=$(funded_contract) || exit 1
read -r C3 F3 <<<"$OUT"
echo "contract $C3, reentrancy finding $F3"
claim_and_prove "$C3" "$F3"
C3_ID=$(cast_in keccak "$C3") || die "keccak failed"
F3_ID=$(cast_in keccak "$F3") || die "keccak failed"
cast_rpc send --private-key "$DEV_KEY" "$DISPUTES" "openDispute(bytes32,bytes32,string)" \
  "$C3_ID" "$F3_ID" "Nobody will rule on this" >/dev/null || die "openDispute failed"
api -b "$WORK/dev" -H 'content-type: application/json' -d '{"reason":"Nobody will rule on this"}' \
  "$API/api/findings/$F3/dispute" >/dev/null || die "dispute route failed"
wait_status "$C3" "$F3" Disputed 30
cast_rpc rpc evm_increaseTime "$((RULING_WINDOW + 1))" >/dev/null || die "evm_increaseTime failed"
cast_rpc rpc evm_mine >/dev/null || die "evm_mine failed"
echo "chain clock moved past the ${RULING_WINDOW}s ruling window"
wait_status "$C3" "$F3" Verified 60
echo "dispute lapsed, finding Verified again"
PENDING_BEFORE=$(pending_payout) || die "reading the profile failed"
wait_status "$C3" "$F3" Paid $((WINDOW + 60))
PENDING=$(pending_payout) || die "reading the profile failed"
[ "$((PENDING - PENDING_BEFORE))" = "$ONE_ETH" ] || die "pending payout went $PENDING_BEFORE -> $PENDING, expected +1 ETH"
cast_rpc send --private-key "$AUD_KEY" "$ESCROW" "withdrawPayout()" >/dev/null || die "withdraw failed"
echo "finding Paid after the lapse, $(cast_in from-wei "$PENDING") ETH withdrawn"

printf '\nLIFECYCLE OK\n'
