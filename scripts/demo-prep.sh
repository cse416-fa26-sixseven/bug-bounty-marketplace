#!/usr/bin/env bash
# Stages the class demo on a fresh `pnpm stack:demo`, so the live part skips
# the slow steps: the developer funds a 1 ETH bounty on Vault.sol and the
# analysis finishes (Slither + LLM, up to ~3 minutes), and the auditor stakes
# 0.1 ETH. Live, the auditor then claims that bounty, uploads the exploit, and
# the payout lands after the 60-second challenge window.
# Needs curl, jq and docker. Prints DEMO READY.
set -euo pipefail

API=${API:-http://localhost:3001}
WEB=${WEB:-http://localhost:3000}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
FIXTURES="$ROOT/workers/analysis/tests/fixtures"

# anvil dev accounts: local demo only.
DEV=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
DEV_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
AUD=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC
AUD_KEY=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a

die() { printf 'DEMO PREP FAILED: %s\n' "$*" >&2; exit 1; }
for tool in curl jq docker; do command -v "$tool" >/dev/null || die "$tool is required"; done

cast_rpc() { docker compose run --rm --no-deps -T --entrypoint cast anvil "$@" --rpc-url http://anvil:8545 2>/dev/null; }
cast_local() { docker compose run --rm --no-deps -T --entrypoint cast anvil "$@" 2>/dev/null; }

CHAIN=$(curl -sf "$API/api/chain") || die "API not reachable at $API: run pnpm stack:demo"
[ "$(echo "$CHAIN" | jq -r .configured)" = "true" ] || die "the API has no chain: run pnpm stack:demo"
ESCROW=$(echo "$CHAIN" | jq -r .addresses.bountyEscrow)
STAKING=$(echo "$CHAIN" | jq -r .addresses.auditorStaking)
JAR=$(mktemp)
trap 'rm -f "$JAR"' EXIT

echo "== Developer signs in and uploads Vault.sol"
MESSAGE=$(curl -sf -H 'content-type: application/json' -d "{\"address\":\"$DEV\"}" "$API/api/auth/nonce" | jq -r .message)
SIGNATURE=$(cast_local wallet sign --private-key "$DEV_KEY" "$MESSAGE")
curl -sf -c "$JAR" -H 'content-type: application/json' \
  -d "$(jq -n --arg message "$MESSAGE" --arg signature "$SIGNATURE" '{$message, $signature}')" \
  "$API/api/auth/login" >/dev/null || die "developer sign-in failed"
CONTRACT=$(curl -sf -b "$JAR" -F "file=@$FIXTURES/Vault.sol" -F bountyAmount=1000000000000000000 \
  -F deadline=2030-01-01T00:00:00.000Z "$API/api/contracts" | jq -r .id)
[ -n "$CONTRACT" ] && [ "$CONTRACT" != null ] || die "upload failed"

echo "== Auditor stakes 0.1 ETH"
if [ "$(cast_rpc call "$STAKING" 'stakeOf(address)(uint256)' "$AUD" | awk '{print $1}')" = 0 ]; then
  cast_rpc send --private-key "$AUD_KEY" --value 0.1ether "$STAKING" "stake()" >/dev/null || die "stake failed"
fi

echo "== Waiting for the analysis (up to 5 minutes); funding waits for it"
STATUS=""
for _ in $(seq 1 300); do
  STATUS=$(curl -sf "$API/api/contracts/$CONTRACT/analysis" | jq -r .status) || true
  [ "$STATUS" = Done ] || [ "$STATUS" = Failed ] && break
  sleep 1
done
[ "$STATUS" = Done ] || die "analysis not done after 5 minutes (last: ${STATUS:-unknown}): check docker compose logs analysis"
FINDING=$(curl -sf "$API/api/contracts/$CONTRACT/findings" \
  | jq -r '[.[] | select(.slitherDetector=="reentrancy-eth")][0].id // empty')
[ -n "$FINDING" ] || die "no reentrancy finding: check docker compose logs analysis"
COUNT=$(curl -sf "$API/api/contracts/$CONTRACT/findings" | jq length)

echo "== Developer funds 1 ETH"
cast_rpc send --private-key "$DEV_KEY" --value 1ether "$ESCROW" "fund(bytes32,uint256)" \
  "$(cast_local keccak "$CONTRACT")" 1893456000 >/dev/null || die "fund failed"
curl -sf -b "$JAR" -X POST "$API/api/contracts/$CONTRACT/funded" >/dev/null || die "funded check failed"

printf '\nDEMO READY\n'
echo "Staged contract: $WEB/contracts/$CONTRACT ($COUNT findings, 1 ETH bounty)"
echo "Exploit to upload live: apps/web/public/examples/VaultExploit.t.sol (also on the Guide page)"
