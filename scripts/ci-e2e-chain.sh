#!/usr/bin/env bash
# Runs the on-chain browser specs (tests/e2e, E2E_CHAIN=1) end to end: a fresh
# demo stack (scripts/demo-stack.sh: anvil, contracts with 60-second windows,
# API, analysis with the PoC sandbox), the web app against the real API, then
# Playwright on one worker. Used by CI's e2e-chain job; runs the same locally.
#
#   scripts/ci-e2e-chain.sh                  # every spec, chain ones included
#   scripts/ci-e2e-chain.sh flows-extra      # extra args go to playwright test
#
# Env:
#   E2E_WEB=compose (default) builds and starts the compose `web` service
#     (production build, mocks off, proxying /api to the api container);
#     E2E_WEB=host expects a web app already on :3000, e.g.
#     NEXT_PUBLIC_API_MOCKING=disabled API_INTERNAL_URL=http://localhost:3001 pnpm --filter @bbm/web dev
#   KEEP_STACK=1 leaves the stack running afterwards (default: torn down).
#   E2E_COMPOSE_LOG=<file> where compose logs go when the run fails
#     (default: compose-e2e-chain.log in the repo root).
#   BBM_COMPOSE_EXTRA is passed through to demo-stack.sh.
# Needs docker (with the socket the sandbox overlay mounts), pnpm and
# Playwright's Chromium (tests/e2e/install-browser.sh).
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

DOCKER_GID=${DOCKER_GID:-$(stat -c %g /var/run/docker.sock)}
export DOCKER_GID
COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.sandbox.yml -f docker-compose.chain.yml)
read -ra extras <<<"${BBM_COMPOSE_EXTRA:-}"
for extra in "${extras[@]}"; do COMPOSE+=(-f "$extra"); done
LOG=${E2E_COMPOSE_LOG:-$ROOT/compose-e2e-chain.log}

step() { printf '\n== %s\n' "$*"; }

cleanup() {
  local status=$?
  if [[ $status -ne 0 ]]; then
    step "Failed (exit $status): compose logs in $LOG"
    "${COMPOSE[@]}" logs --no-color --timestamps > "$LOG" 2>&1 || true
  fi
  if [[ -z "${KEEP_STACK:-}" ]]; then
    step "Stopping the stack"
    "${COMPOSE[@]}" --profile deploy down -v --remove-orphans || true
  fi
  exit "$status"
}
trap cleanup EXIT

bash scripts/demo-stack.sh

if [[ "${E2E_WEB:-compose}" == compose ]]; then
  step "Starting the web app (mocks off)"
  NEXT_PUBLIC_API_MOCKING=disabled "${COMPOSE[@]}" up -d --build --wait web
fi

step "Waiting for the web app"
for _ in $(seq 1 60); do
  curl -fsS -o /dev/null http://localhost:3000/ && break
  sleep 2
done
curl -fsS -o /dev/null http://localhost:3000/

step "Playwright (E2E_CHAIN=1)"
# No retries: a failed chain spec can leave the auditor holding a claim, so a
# retry on the same stack would fail for a different reason.
E2E_CHAIN=1 pnpm --filter @bbm/system-tests run e2e --retries=0 "$@"
