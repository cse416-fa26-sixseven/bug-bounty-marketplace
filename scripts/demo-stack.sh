#!/usr/bin/env bash
# Starts a fresh full-lifecycle demo stack: empty database, new anvil chain,
# contracts deployed with a 60-second challenge window, the API pointed at
# them and the analysis service running PoCs in the sandbox.
#   pnpm stack:demo
# Then run the web app against it with no mocks (see README "Full lifecycle demo").
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

DOCKER_GID=${DOCKER_GID:-$(stat -c %g /var/run/docker.sock)}
export DOCKER_GID
COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.sandbox.yml -f docker-compose.chain.yml)

step() { printf '\n== %s\n' "$*"; }

step "Removing the previous stack, database and chain"
"${COMPOSE[@]}" --profile deploy down -v --remove-orphans

if ! docker image inspect bbm-sandbox:latest >/dev/null 2>&1; then
  step "Building the PoC sandbox image"
  docker build -f workers/sandbox/Dockerfile -t bbm-sandbox:latest workers
fi

step "Starting the database and anvil"
"${COMPOSE[@]}" up -d --build --wait db anvil

step "Deploying the contracts"
"${COMPOSE[@]}" run --rm contracts-deploy

step "Starting the API and the analysis service"
"${COMPOSE[@]}" up -d --build --wait api analysis

step "Deployment"
"${COMPOSE[@]}" run --rm --no-deps --entrypoint cat contracts-deploy /contracts/deployments/31337.json
echo
step "GET /api/chain"
curl -sf http://localhost:3001/api/chain
echo
echo "Demo stack ready. Web: NEXT_PUBLIC_API_MOCKING=disabled API_INTERNAL_URL=http://localhost:3001 pnpm --filter @bbm/web dev"
