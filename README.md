# Bug Bounty Marketplace

An AI-assisted smart contract security and bug-bounty marketplace.

A developer submits a Solidity contract and funds a bounty held in on-chain
escrow. Slither runs static analysis; an LLM explains each finding in plain
English (advisory only — it never changes a finding's status or payout). An
auditor stakes a deposit, claims the contract exclusively and time-limitedly,
and submits a Foundry proof-of-concept (PoC). A sandbox re-runs the PoC; only
a successful reproduction marks a finding **Verified**. After the challenge
window passes with no dispute, escrow pays the auditor (first verified PoC
wins, and the bounty closes). The developer can dispute a Verified finding
during the challenge window; an admin arbiter rules, and a losing auditor's
stake is slashed. Auditors can also mark AI findings as false positives.

Finding statuses: `Flagged → Submitted → Verified → Disputed/Rejected → Paid`.

## Repository layout

```
.
├── apps/
│   ├── web/              # Next.js frontend (MSW mocks for the developer/auditor/arbiter flows)
│   └── api/              # Fastify API: /health, contract upload, Postgres + migrations
├── packages/
│   └── shared/           # @bbm/shared: Zod schemas + generated JSON Schema (schema/*.json)
├── tests/                # @bbm/system-tests: integration, regression, smoke, e2e, load
├── workers/
│   └── analysis/         # Python (uv, FastAPI) Slither + LLM worker; not a pnpm package
├── contracts/            # Foundry: AuditorStaking, BountyEscrow, DisputeResolution, Deploy.s.sol
├── infra/                # Azure: up.sh / down.sh (one-command bring-up/teardown), lib/
│   └── terraform/        # modules, stacks (bootstrap/global/data/compute), envs, scripts
├── deploy/helm/          # charts: bbm (the app), bbm-platform (cert-manager issuers, TLS, ingress)
├── deploy/platform/      # install.sh: cert-manager + bbm-platform, once per cluster
├── docs/                 # Package docs, ADRs, DevOps runbooks
├── uml/                  # Mermaid sources + rendered class/sequence/deployment diagrams
├── .github/workflows/    # ci.yml plus the Azure workflows
├── docker-compose.yml    # full local stack (+ docker-compose.ci.yml overrides for CI)
└── CLAUDE.md             # contributor + agent conventions
```

## Setup

```sh
git clone --recurse-submodules <repo>    # forge-std is a submodule under contracts/lib
cd bug-bounty-marketplace

nvm use                      # Node 20 (see .nvmrc)
corepack enable              # or: npm install -g pnpm@9
pnpm install

pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

Other toolchains, only for the parts you touch: Docker (Compose ≥ 2.24) for
the stack, [Foundry v1.3.5](docs/contracts/foundry-setup.md) for
`contracts/`, [uv](https://docs.astral.sh/uv/) for `workers/analysis`, and
Terraform 1.9.8 / TFLint / Helm 3 for `infra/` and `deploy/`.

### Web app against mocks

```sh
NEXT_PUBLIC_API_MOCKING=enabled pnpm dev      # http://localhost:3000
```

With mocking enabled the frontend runs entirely against MSW handlers
(`apps/web/src/mocks/handlers/{developer,auditor,arbiter}.ts`), so the full
developer → auditor → arbiter flow works without an API, database or chain.

### API on its own

```sh
docker compose up -d db
DATABASE_URL=postgres://bbm:bbm@localhost:5432/bbm pnpm --filter @bbm/api dev
```

Without `DATABASE_URL` the API keeps contracts in memory. Endpoints and
environment variables are in [docs/api.md](docs/api.md).

## Running the stack

The whole system runs in Docker Compose, built from the repo's Dockerfiles:

```sh
pnpm stack:up                  # build + start db, api, web, analysis, anvil; waits for healthchecks
pnpm stack:deploy-contracts    # one-shot: deploy and wire the contracts on anvil
pnpm stack:down                # stop and remove containers and volumes
pnpm stack:ci                  # what CI runs: prebuilt images, tmpfs Postgres, no build
```

| Service    | Port   | Health           |
| ---------- | ------ | ---------------- |
| `web`      | `3000` | `GET /healthz`   |
| `api`      | `3001` | `GET /health`    |
| `analysis` | `8000` | `GET /health`    |
| `anvil`    | `8545` | chain id `31337` |
| `db`       | `5432` | `bbm` / `bbm`    |

The web image calls the API through its `/api/*` proxy
(`API_INTERNAL_URL=http://api:3001`). Build it with
`NEXT_PUBLIC_API_MOCKING=enabled pnpm stack:up` to serve the MSW mocks
instead. Images are tagged `${BBM_REGISTRY:-bbm}/<svc>:${BBM_TAG:-local}`.

### Live analysis pipeline

Runs Slither + LLM analysis and the PoC sandbox for real (design:
[analysis pipeline spec](docs/superpowers/specs/2026-10-19-analysis-pipeline-design.md)).
The `analysis` service polls the jobs the API queues; sandbox jobs need the
opt-in overlay, which mounts the Docker socket. For LLM explanations put
`LLM_ENDPOINT`, `LLM_MODEL` and `LLM_API_KEY` in `workers/analysis/.env`
(git-ignored); without them explanations fall back to Slither's text.

```sh
docker build -f workers/sandbox/Dockerfile -t bbm-sandbox:latest workers
export DOCKER_GID=$(stat -c %g /var/run/docker.sock)
docker compose -f docker-compose.yml -f docker-compose.sandbox.yml up -d --build --wait db api analysis
./scripts/demo-pipeline.sh     # submit -> findings -> claim -> PoC Verified / Rejected; prints DEMO OK

# The web app with the pipeline routes live and everything else mocked:
NEXT_PUBLIC_API_MOCKING=enabled NEXT_PUBLIC_LIVE_PIPELINE=enabled \
  API_INTERNAL_URL=http://localhost:3001 pnpm --filter @bbm/web dev
```

PoCs are Foundry tests that import the target as `import "../src/<filename>";`
(see [workers/sandbox](workers/sandbox/README.md)).

In live mode only the pipeline routes are real: upload, contract pages,
findings, analysis status, the auditor queue, claim and PoC upload. Stake,
the auditor profile, disputes, false-positive marking, reclaim/cancel and the
arbiter stay mocked, so those buttons answer "not found" for real contracts
and the profile's claimed list shows only seeded contracts; keep the demo to
the pipeline steps.

### Full lifecycle demo (on-chain)

`pnpm stack:demo` starts a fresh demo stack: it removes the previous
database and chain, starts Postgres and a local anvil chain, deploys the
contracts with a 60-second challenge window, then starts the API (pointed at
the deployment through `docker-compose.chain.yml`) and the analysis service
with the PoC sandbox. It prints the deployment and `GET /api/chain`.

Run the web app in live chain mode against it. `NEXT_PUBLIC_LIVE_CHAIN`
sends the chain description, sign-in and every lifecycle route (funding,
cancel, reclaim, profile, disputes, rulings) to the real API. Each role signs
its transactions in the browser with its anvil account (developer, auditor,
arbiter) and signs in to the API with a signed message when you switch roles.
Without `NEXT_PUBLIC_LIVE_CHAIN` the chain stays mocked, so the app never
signs anything.

```sh
pnpm stack:demo
NEXT_PUBLIC_API_MOCKING=enabled NEXT_PUBLIC_LIVE_PIPELINE=enabled NEXT_PUBLIC_LIVE_CHAIN=enabled \
  API_INTERNAL_URL=http://localhost:3001 pnpm --filter @bbm/web dev
```

`pnpm demo:lifecycle` runs the whole lifecycle against the demo stack from
the command line, with cast signing for each role. The payout path is fund,
stake, claim, passing PoC, Verified, Paid after the 60-second window, then
withdraw. The dispute path is a second bounty, Verified, disputed, then
ruled against the auditor, which rejects the finding and slashes half the
stake. It prints `LIFECYCLE OK` (needs `curl` and `jq`). The same two paths
run in the browser with
`E2E_CHAIN=1 pnpm test:e2e -- lifecycle`, against a fresh `pnpm stack:demo`
and the web app above.

If a step fails after its transaction went through (for example the API was
unreachable), repeat it: a step that already happened on-chain goes straight
to the API call.

The overlay uses anvil's well-known dev keys (local demo only). If an image
build fails with `error getting credentials` on WSL, Docker Desktop's
credential helper is unreachable; the images are public, so run it with an
empty Docker config: `mkdir -p /tmp/dc && echo '{}' > /tmp/dc/config.json &&
DOCKER_CONFIG=/tmp/dc pnpm stack:demo`.

## Testing

| Tier               | Where                                                       | Command                                           |
| ------------------ | ----------------------------------------------------------- | ------------------------------------------------- |
| Unit               | next to the code (vitest, `forge test`, pytest)             | `pnpm test`, `forge test`, `uv run pytest`        |
| DB integration     | `apps/api/src/**/pg-repository.test.ts`                     | `pnpm --filter @bbm/api test` with `DATABASE_URL` |
| System integration | `tests/integration/`                                        | `pnpm test:integration`                           |
| Regression         | API goldens, `contracts/.gas-snapshot`, shared schema drift | `pnpm test:regression`, `forge snapshot --check`  |
| Smoke              | `tests/smoke/`                                              | `pnpm test:smoke`                                 |
| E2E                | `tests/e2e/` (Playwright)                                   | `pnpm test:e2e`                                   |
| Load               | `tests/load/` (k6)                                          | see `tests/load/README.md`                        |

Unit tests never touch the network. The system tiers run against a live
stack (`pnpm stack:up` first) and are never part of `pnpm test`. Details,
environment variables and how to update goldens: [tests/README.md](tests/README.md).

## CI/CD

### `ci.yml` (every push and PR)

A `changes` job (`dorny/paths-filter`) decides which jobs run. Root config
(`package.json`, lockfile, workspace, base tsconfig, ESLint/Prettier config,
`ci.yml`) fans out to every TS job.

| Job                | What it does                                                                                                                 |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `web`              | lint, typecheck, test, build                                                                                                 |
| `shared`           | lint, typecheck, test, `gen:schema`, fail if `packages/shared/schema` drifted                                                |
| `api`              | lint, typecheck, test (with a Postgres service), build, boot the built API and wait for `/health`                            |
| `contracts`        | `forge build`, `forge test`, `forge snapshot --check`, deploy-script dry run, Slither (advisory, `fail-on: none`)            |
| `analysis`         | `uv sync --frozen`, ruff check + format, pytest, generated-models drift check                                                |
| `containers`       | hadolint, build every image (GHA cache), non-root check, compose stack up, deploy to anvil, integration/regression/smoke/e2e |
| `terraform-static` | `infra/terraform/scripts/ci-static.sh`: fmt, validate, `terraform test`, tflint, shellcheck                                  |
| `helm`             | `helm lint` every values layer, render + kubeconform, missing-tag render must fail, `ct lint`                                |
| `workflows`        | actionlint                                                                                                                   |
| `CI OK`            | always runs; passes when `changes` succeeded and every other job succeeded or was skipped                                    |

`ci.yml` never logs in to Azure, so `CI OK` never depends on cloud
credentials, quota or uptime. `CI OK` is the required status check on `main`
(ruleset source of truth: `.github/rulesets/main.json`; apply changes with
`gh api -X PUT repos/cse416-fa26-sixseven/bug-bounty-marketplace/rulesets/24287837 --input .github/rulesets/main.json`).

### Azure workflows

All authenticate with GitHub OIDC (no secrets) and skip green until the
bootstrap repo variables exist.

| Workflow                | Trigger                         | What it does                                                                                       |
| ----------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------- |
| `_build-push.yml`       | reusable                        | build and push images to ACR (`bbm/<svc>:<tag>`) with SBOM + provenance                            |
| `_ephemeral-env.yml`    | reusable                        | deploy or delete one namespace on the test AKS cluster (auto-resumes a paused cluster)             |
| `integration-azure.yml` | push to `main`, nightly, manual | namespace `run-<id>-<attempt>` on the test cluster: smoke, integration, e2e (+ k6), always deleted |
| `preview.yml`           | PR open/push/close              | namespace `pr-<n>` on the test cluster (mocked web), sticky comment, deleted on close              |
| `terraform.yml`         | PR, push to `main`, manual      | plan on PRs, apply `global` on `main` (infra-global approval), manual plan/apply per stack         |
| `cd.yml`                | green `integration-azure` on a push to `main` | deploy that build to staging, then prod after reviewer approval ([cd.md](docs/devops/cd.md)) |
| `deploy.yml`            | called by `cd.yml` / env-power, or manual | platform install, Helm deploy to staging/prod AKS, then smoke; manual runs for rollbacks |
| `env-power.yml`         | manual, schedules               | `status` / `pause` / `resume` / `down` / `up` for test/staging/prod, nightly auto-pause            |
| `contracts-deploy.yml`  | manual                          | deploy the contracts to Sepolia (dry run by default)                                               |
| `infra-janitor.yml`     | every 6 h, weekly, manual       | delete expired ephemeral namespaces, weekly ACR purge                                              |

## Infrastructure and environments

| Environment  | Platform                               | Host                             | Lifetime                        |
| ------------ | -------------------------------------- | -------------------------------- | ------------------------------- |
| `test`       | own AKS cluster (Free tier)            | (no app release of its own)      | long-lived, powered on demand   |
| ↳ CI run     | namespace `run-<id>-<attempt>` on test | `run-<id>-<attempt>.test.<zone>` | one `integration-azure.yml` run |
| ↳ PR preview | namespace `pr-<n>` on test             | `pr-<n>.preview.<zone>`          | PR open → close                 |
| `staging`    | own AKS cluster (Free tier)            | `staging.<zone>`                 | long-lived, powered on demand   |
| `prod`       | own AKS cluster (Standard tier)        | `prod.<zone>`                    | long-lived, powered on demand   |

Each env is split into a persistent `data` stack (Postgres, Key Vault,
storage, IP, DNS records) and a disposable `compute` stack (AKS). They are
turned off and on with the **Env power** workflow without losing data, and
pause automatically every night. All hosts are HTTPS (Let's Encrypt wildcard
per env) under one Azure DNS zone, `dns_zone_name`. `infra/up.sh` brings the
whole footprint up on a subscription and `infra/down.sh` tears it down.

- [ADR 0001](docs/adr/0001-azure-environment-topology.md): topology and pinned interfaces
- [ADR 0002](docs/adr/0002-aks-everywhere-and-azure-dns.md): AKS for every env, Azure DNS, TLS, one-command bring-up
- [Architecture](docs/devops/architecture.md) and [cost](docs/devops/cost.md)
- [Environment lifecycle](docs/devops/env-lifecycle.md): power runbook, test env, demo-day checklist
- [Azure bootstrap](docs/devops/azure-bootstrap.md): bring-up with `infra/up.sh`, what stays manual
- [Switching accounts or domains](docs/devops/switching-accounts.md)
- [infra/terraform/README.md](infra/terraform/README.md) and [deploy/helm/README.md](deploy/helm/README.md)

## Contributing

Work happens on milestone integration branches (currently `feat/m3-devops`)
via small, reviewed sub-branches. See [CLAUDE.md](CLAUDE.md) for commands,
conventions and the git workflow, and [docs/](docs/README.md) for everything
else.

## Frontend MVP (BountyGuard)

From the repository root on Windows PowerShell:

```powershell
pnpm install
pnpm dev
```

Open http://localhost:3000. The frontend defaults to the self-contained MSW demo.
No API server, database, wallet extension, or blockchain is needed. The dark
workspace includes an overview, searchable contract portfolio, submission form,
auditor queue with staking and PoC uploads, and dispute review. The in-app
Getting started page includes sample Solidity and PoC files.

Use the sidebar or role selector to switch actors. Navigation preserves the
in-memory demo; a full reload resets it. The displayed wallets, stakes, analysis,
verification, and payments are simulated. Sample PoC files demonstrate uploads,
not working exploits. AI explanations are advisory; only the simulated sandbox
changes verification status.

For live API integration, set `NEXT_PUBLIC_API_MOCKING=disabled` before
starting/building and set `API_INTERNAL_URL` to the API origin. The Next.js
proxy forwards `/api/*` to that origin; complete frontend flows still require
the corresponding backend endpoints. This switch alone
does not implement wallet authentication or on-chain transactions.

If the mock worker needs regeneration after an MSW dependency change:

```powershell
pnpm --filter @bbm/web exec msw init public --save
```

Frontend checks: `pnpm --filter @bbm/web typecheck`, `pnpm --filter @bbm/web lint`,
`pnpm --filter @bbm/web test`, and `pnpm --filter @bbm/web build`.
