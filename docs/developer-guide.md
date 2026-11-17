# Developer Guide

How the Bug Bounty Marketplace is built, how to run it, where things live and
how to change it. This page gives the overview and links to the detailed
per-package docs and runbooks rather than repeating them.

1. [Architecture overview](#1-architecture-overview)
2. [Setting up a development environment](#2-setting-up-a-development-environment)
3. [Codebase structure and module overview](#3-codebase-structure-and-module-overview)
4. [How to contribute and extend the system](#4-how-to-contribute-and-extend-the-system)

## 1. Architecture overview

> The full architecture description is Section 1 of the Milestone 2 design
> document, updated in Milestone 4: **TODO: link to the M2/M4 document,
> Section 1**. This section summarises it and points to the diagrams and
> design records kept in the repo.

A developer uploads a Solidity contract and funds a bounty held in on-chain
escrow. The analysis worker runs Slither and asks an LLM to explain each
finding (advisory only: the LLM never changes a status or a payout). An
auditor stakes, claims the contract for a limited time and uploads a Foundry
proof of concept (PoC). The sandbox re-runs the PoC, and only a reproduced
PoC makes a finding **Verified**. If the developer does not dispute it within
the challenge window, escrow pays the auditor. If they dispute it, the
arbiter rules, and an auditor who loses has half their stake slashed.

```
                 ┌──────────────┐  /api/* proxy  ┌──────────────┐   SQL    ┌────────────┐
 browser ───────▶│  web (Next)  │───────────────▶│ api (Fastify)│─────────▶│  Postgres  │
 (MetaMask/SIWE) └──────────────┘                └──────┬───────┘          └─────▲──────┘
        │                                               │ viem: reads, operator   │ jobs table
        │ signs user transactions                       │ txs, event indexer      │ (poll)
        ▼                                               ▼                   ┌─────┴──────┐
 ┌────────────────────────────────────────────────────────────────┐        │  analysis  │
 │ chain (anvil / Sepolia): BountyEscrow, AuditorStaking,          │        │ (FastAPI + │
 │ DisputeResolution                                               │        │  worker)   │
 └────────────────────────────────────────────────────────────────┘        └─────┬──────┘
                                                                     Slither, LLM │ PoC run
                                                                                  ▼
                                                                          ┌──────────────┐
                                                                          │ sandbox      │
                                                                          │ (offline     │
                                                                          │  Foundry)    │
                                                                          └──────────────┘
```

| Component | Source             | Role                                                                                                                                     |
| --------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| web       | `apps/web`         | Next.js UI for the developer, auditor and arbiter. Forwards `/api/*` to the API, or serves MSW mocks.                                    |
| api       | `apps/api`         | Fastify. Owns the database, enforces every status transition, queues jobs, signs operator transactions and indexes contract events.      |
| analysis  | `workers/analysis` | Python. Polls the `jobs` table: analysis jobs run Slither and the LLM explainer; sandbox jobs run a PoC and report Verified or Rejected. |
| sandbox   | `workers/sandbox`  | Offline Foundry image a PoC runs in: a throwaway container under Compose, a Kata-isolated Job on AKS.                                    |
| contracts | `contracts`        | Foundry: `BountyEscrow` (bounty and payout), `AuditorStaking` (stake, locks, slashing), `DisputeResolution` (disputes, rulings).         |
| shared    | `packages/shared`  | Zod schemas: the data contract between web, api, tests and (through generated JSON Schema) the Python worker.                            |

Key design rules:

- **One place decides status.** Every finding and contract status change goes
  through `transitionFinding` / the tables in
  `apps/api/src/status/transitions.ts`, whether it comes from an API route or
  from the chain event indexer.
  Finding lifecycle: `Flagged → Submitted → Verified → Disputed/Rejected → Paid`.
- **The chain holds the money; the API holds the workflow.** Users sign their
  own transactions (fund, stake, dispute) in the browser. The API signs only
  as the operator (record a submission or verification, lock stakes) and
  reads events back to update the database.
- **The LLM is advisory.** Its text is shown next to a finding but never
  read by status or payout logic.
- **Storage is pluggable.** Every API store is an interface with in-memory
  and Postgres implementations, so unit tests need no database.

Diagrams and design records in the repo:

- [`uml/`](../uml/): class diagram, component/deployment diagram and three
  sequence diagrams (submit and analysis; claim, stake, PoC and verify;
  dispute or automatic payout).
- [DevOps architecture](devops/architecture.md): containers, environments,
  request path and identity flow on Azure.
- Design specs: [analysis pipeline](superpowers/specs/2026-10-19-analysis-pipeline-design.md),
  [on-chain lifecycle](superpowers/specs/2026-10-20-onchain-lifecycle-design.md),
  [PoC sandbox on AKS](superpowers/specs/2026-11-05-sandbox-aks-design.md).
- ADRs: [0001](adr/0001-azure-environment-topology.md),
  [0002](adr/0002-aks-everywhere-and-azure-dns.md),
  [0003](adr/0003-shared-subscription-isolation.md),
  [0004](adr/0004-poc-sandbox-on-aks.md).

## 2. Setting up a development environment

### Prerequisites

| Tool                                         | Needed for                                |
| -------------------------------------------- | ----------------------------------------- |
| Node 22 (`.nvmrc`) and pnpm 9                | everything TypeScript                     |
| Git (with submodules)                        | `contracts/lib/forge-std`                 |
| Docker with Compose ≥ 2.24                   | the local stack, Postgres, sandbox        |
| [Foundry v1.3.5](contracts/foundry-setup.md) | `contracts/`                              |
| [uv](https://docs.astral.sh/uv/)             | `workers/analysis` (installs Python 3.12) |
| Terraform 1.9.8, TFLint, Helm 3              | only for `infra/` and `deploy/`           |

You only need the toolchains for the parts you change. A frontend-only
change needs nothing beyond Node and pnpm.

### Clone and install

```sh
git clone --recurse-submodules <repo>
cd bug-bounty-marketplace
nvm use
corepack enable                 # or: npm install -g pnpm@9
pnpm install

pnpm lint && pnpm typecheck && pnpm test && pnpm build   # should be green
```

### Pick a way to run it

From lightest to heaviest:

1. **Web app with mocks** (no API, database or chain). Good for UI work.

   ```sh
   NEXT_PUBLIC_API_MOCKING=enabled pnpm dev      # http://localhost:3000
   ```

2. **API on its own.** Without `DATABASE_URL` it keeps everything in memory;
   with it, migrations run on start-up (`MIGRATE_ON_BOOT`, default on).

   ```sh
   docker compose up -d db
   DATABASE_URL=postgres://bbm:bbm@localhost:5432/bbm pnpm --filter @bbm/api dev
   ```

3. **Analysis worker on its own.**

   ```sh
   cd workers/analysis && uv sync
   uv run uvicorn analysis.app:app --reload --port 8000
   ```

   For LLM explanations, put `LLM_ENDPOINT`, `LLM_MODEL` and `LLM_API_KEY` in
   `workers/analysis/.env` (git-ignored; see `.env.example`). Without them,
   explanations fall back to Slither's own text.

4. **Full stack in Docker Compose** (db, api, web, analysis, anvil):

   ```sh
   pnpm stack:up
   pnpm stack:deploy-contracts
   pnpm stack:down              # stops and removes volumes
   ```

   Ports: web `3000`, api `3001`, analysis `8000`, anvil `8545`, Postgres
   `5432` (`bbm`/`bbm`).

5. **Full on-chain lifecycle** (fresh database and chain, contracts deployed
   with a 60-second challenge window, PoC sandbox on):

   ```sh
   docker build -f workers/sandbox/Dockerfile -t bbm-sandbox:latest workers
   pnpm stack:demo
   NEXT_PUBLIC_API_MOCKING=disabled API_INTERNAL_URL=http://localhost:3001 \
     pnpm --filter @bbm/web dev
   pnpm demo:lifecycle          # optional: the whole lifecycle from the CLI; prints LIFECYCLE OK
   ```

   Import anvil's developer, auditor and arbiter accounts into MetaMask to
   sign as each role. See [Sepolia runbook](contracts/sepolia.md) for the
   testnet.

The Azure environments (test, staging, prod) are not needed for development;
see [Azure bootstrap](devops/azure-bootstrap.md) if you need to bring one up.

### Running the tests

| What                       | Command                                                              |
| -------------------------- | -------------------------------------------------------------------- |
| All TS unit tests          | `pnpm -r test` (no network, no stack)                                |
| API with Postgres          | `DATABASE_URL=... pnpm --filter @bbm/api test`                       |
| Contracts                  | `cd contracts && forge test` (`forge snapshot` after gas changes)    |
| Analysis worker            | `cd workers/analysis && uv run pytest -q`                            |
| System tiers (needs stack) | `pnpm test:integration`, `test:regression`, `test:smoke`, `test:e2e` |

[tests/README.md](../tests/README.md) covers each system tier, its
environment variables and how to update the regression goldens.

### Troubleshooting

- **`error getting credentials` when building images on WSL:** run with an
  empty Docker config (`DOCKER_CONFIG=/tmp/dc`, containing `{}`).
- **Sandbox jobs never finish:** the sandbox needs the opt-in
  `docker-compose.sandbox.yml` overlay, `DOCKER_GID` set to the Docker
  socket's group, and the `bbm-sandbox:latest` image built.
- **Analysis jobs stay `Queued`:** the worker only reads Postgres. An API
  running without `DATABASE_URL` keeps jobs in memory, where nothing
  processes them.
- **A transaction went through but the step failed in the UI:** repeat the
  step. A step already done on-chain skips straight to the API call.

## 3. Codebase structure and module overview

The repo is a pnpm monorepo. `apps/*`, `packages/*` and `tests` are pnpm
packages; `workers/*` and `contracts/` have their own toolchains.

```
apps/
  web/                 Next.js frontend                         → docs/web.md
  api/                 Fastify API                              → docs/api.md
packages/
  shared/              Zod schemas, generated JSON Schema, ABIs → docs/shared.md
workers/
  analysis/            Python worker: Slither, LLM, job loop    → workers/analysis/README.md
  sandbox/             Offline Foundry image for PoCs           → workers/sandbox/README.md
contracts/             Foundry: escrow, staking, disputes       → docs/contracts/overview.md
tests/                 @bbm/system-tests: integration, regression, smoke, e2e, load
infra/                 Azure Terraform, up.sh / down.sh         → infra/terraform/README.md
deploy/helm/           Helm charts bbm and bbm-platform         → deploy/helm/README.md
scripts/               stack, demo and CI helper scripts
uml/                   Mermaid diagrams (+ rendered PNG)
docs/                  this guide, package docs, ADRs, runbooks, specs
.github/workflows/     ci.yml and the Azure workflows
```

### `apps/api` (Fastify, TypeScript)

`src/app.ts` builds the app from `AppOptions` (every dependency is
injectable, with in-memory defaults); `src/index.ts` reads the environment,
connects Postgres and the chain, and passes the real implementations in.

| Module       | Responsibility                                                                                                             |
| ------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `contracts/` | Contract upload, listing, auditor queue and claims; source storage (memory, disk, Azure Blob); lifecycle routes.           |
| `pipeline/`  | Findings, PoCs, jobs, analysis status, developer notes; reads sandbox verdicts.                                            |
| `status/`    | The finding and contract transition tables and the guarded status writer.                                                  |
| `disputes/`  | Disputes, rulings and false-positive marks.                                                                                |
| `chain/`     | viem clients, typed ports for the three contracts, operator transactions, the verdict loop, payout keeper, dispute lapser. |
| `indexer/`   | Reads contract events and applies them to the database (claim locks, dispute settlement, finding status).                  |
| `auth/`      | Sign-In with Ethereum (EIP-4361) and HMAC session cookies.                                                                 |
| `http/`      | Multipart helpers and per-IP rate limiting.                                                                                |
| `db/`        | Migration runner and numbered SQL migrations (`migrations/0001_…sql` onward).                                              |
| `testing/`   | Test helpers, including `repository-suite.ts`, one test suite run against both the memory and Postgres repositories.       |

Most areas follow the same pattern: `repository.ts` (interface),
`memory-repository.ts`, `pg-repository.ts`, `routes.ts` and tests next to
each file.

### `apps/web` (Next.js, TypeScript)

| Path                                | Responsibility                                                                                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/app/`                          | Routes: `submit`, `contracts` (developer), `auditor`, `arbiter`, `guide`, `healthz`.                                                              |
| `src/components/`                   | Shared UI (header, role switcher, status badge, wallet badge, tx link).                                                                           |
| `src/lib/api/`                      | Typed API clients per role; responses are parsed with `@bbm/shared` schemas.                                                                      |
| `src/lib/chain/`, `src/lib/wallet/` | Chain config from `GET /api/chain`, contract calls, wallet and transaction tracking.                                                              |
| `src/mocks/handlers/`               | MSW handlers split by role (`developer`, `auditor`, `arbiter`, `chain`), composed in `index.ts`; `live.ts` lets real routes through in live mode. |
| `src/mocks/db/`                     | In-memory mock database, split the same way.                                                                                                      |
| `src/proxy.ts`                      | Forwards `/api/*` to `API_INTERNAL_URL`.                                                                                                          |

### `packages/shared`

The single source of truth for data shapes: `contract.ts`, `bounty.ts`,
`finding.ts`, `poc-submission.ts`, `dispute.ts`, `auditor-profile.ts`,
`analysis.ts`, `chain.ts`, `wei.ts`, plus the contract ABIs in `src/abi/`.
`schema/*.json` is generated from the Zod schemas for the Python worker.

### `workers/analysis` (Python, uv)

| Module                                                           | Responsibility                                                         |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `worker.py`, `jobs.py`                                           | Job loop: claims jobs from the Postgres `jobs` table.                  |
| `analysis_job.py`, `slither_runner.py`, `solc.py`, `findings.py` | Run Slither with the right `solc`, turn detector output into findings. |
| `llm.py`                                                         | LLM explanations (advisory, with a Slither-text fallback).             |
| `sandbox_job.py`, `sandbox.py`, `sandbox_k8s.py`                 | Run a PoC in the sandbox (Docker locally, Kata Job on AKS).            |
| `app.py`                                                         | FastAPI: `/health` and `/analyze`.                                     |
| `generated/models.py`                                            | Pydantic models generated from the shared JSON Schema (do not edit).   |

### `contracts` (Solidity, Foundry)

`src/BountyEscrow.sol`, `src/AuditorStaking.sol`, `src/DisputeResolution.sol`,
deployed and wired by `script/Deploy.s.sol` (the wiring order matters; see
[contracts overview](contracts/overview.md)). Tests are in `test/`, gas
numbers in the committed `.gas-snapshot`.

### `tests` (`@bbm/system-tests`)

Integration, regression (API goldens), smoke, Playwright E2E and k6 load
tests that run against a live stack. It has no `test` script on purpose, so
`pnpm -r test` never needs a stack.

## 4. How to contribute and extend the system

### Workflow

1. Pull the current milestone integration branch (see
   [CLAUDE.md](../CLAUDE.md#git-workflow); currently `feat/m5-testing`) and
   cut a sub-branch from it, named by type: `feat/…`, `fix/…`, `test/…`,
   `docs/…`, `ci/…`.
2. Commit in small [Conventional Commits](https://www.conventionalcommits.org/)
   (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`, `ci:`).
3. Before each commit, run lint, typecheck, test and build for whatever you
   touched (for infra: `ci-static.sh`, `helm lint`, actionlint). Commit only
   when green.
4. Open a PR into the integration branch with `gh pr create`. CI's `ci.yml`
   path-filters its jobs; the required check is `CI OK`.
5. Have the PR diff reviewed by a fresh reviewer (correctness and tests,
   schema consistency across packages, no real network calls in unit tests,
   no scope creep), and address the findings.
6. Merge with `gh pr merge --merge --delete-branch` (a merge commit, not a
   squash).

The milestone's final integration-branch → `main` PR is left for team review.

### Rules that keep the codebase consistent

- TypeScript is `strict` everywhere; packages extend `tsconfig.base.json`.
- Unit tests never touch the network. Use the in-memory repositories, MSW,
  or injected fakes; the Python tests run with sockets disabled.
- Never edit generated files by hand: `packages/shared/schema/*.json`,
  `workers/analysis/src/analysis/generated/models.py`, the ABIs. CI fails on
  drift.
- Status changes only through `status/transitions.ts`.
- Never commit secrets, domains or subscription IDs. Local secrets go in
  git-ignored `.env` files; cloud secrets go in Key Vault.
- Keep `ci.yml` free of Azure. Anything that needs cloud credentials goes in
  its own workflow.

### Common extensions

**Change or add a data type.**

1. Edit or add the Zod schema in `packages/shared/src/` and export it from
   `index.ts`.
2. `pnpm --filter @bbm/shared gen:schema`, then in `workers/analysis`
   `uv run scripts/gen-types.sh`. Commit both outputs.
3. Update the API repositories (and a new migration if the database changes),
   the web clients and mocks, and the regression goldens if responses change
   (`pnpm --filter @bbm/system-tests test:regression -u`).

**Add an API endpoint.**

1. Put the route in the matching area's `routes.ts` (or a new area with its
   own `register…Routes` function, registered in `registerRoutes` in
   `src/app.ts`).
2. Validate input and shape output with `@bbm/shared` schemas.
3. If it needs storage, add the method to the area's repository interface and
   implement it in both `memory-repository.ts` and `pg-repository.ts`; cover
   both through `describeRepositories` in `src/testing/repository-suite.ts`.
4. Test with `app.inject` (see existing `routes.test.ts`), add an integration
   test in `tests/integration/`, and document the route in
   [docs/api.md](api.md).
5. Add the matching MSW handler in `apps/web/src/mocks/handlers/` so the
   mocked UI keeps working.

**Change the database.** Add the next numbered file in
`apps/api/src/db/migrations/` (for example `0012_<name>.sql`). Never edit a
migration that has been merged. Migrations run on API start-up and through
`pnpm --filter @bbm/api migrate`. Add a migration test when the change moves
existing data (see `migration-0011.test.ts`).

**Add a finding or contract status, or a new transition.** Change
`FindingStatusSchema` / `ContractStatusSchema` in `@bbm/shared` and the tables
in `apps/api/src/status/transitions.ts` together, update the indexer if an
on-chain event drives it, and update the status badge in the web app and the
docs (README lifecycle, `uml/`).

**Add a page or UI flow.** Add the route under `apps/web/src/app/`, the API
client function in `src/lib/api/<role>.ts`, and handlers and fixture data in
that role's `mocks/handlers/` and `mocks/db/` files. Put shared UI in
`src/components/`. Test with vitest and, for a full flow, a Playwright spec
in `tests/e2e/`.

**Change a smart contract.** Edit `contracts/src/`, add forge tests, run
`forge snapshot` and commit `.gas-snapshot`. If the ABI changes, regenerate
`packages/shared/src/abi/` (`pnpm --filter @bbm/shared gen:abi`) and update
the API's `chain/` port and the web's `lib/chain/calls.ts`. Update
`script/Deploy.s.sol` if the wiring changes.

**Add a Slither post-processing step or change the LLM explainer.** Work in
`workers/analysis/src/analysis/` (`findings.py`, `llm.py`), add pytest cases
with recorded fixtures (no live LLM calls in tests), and run
`uv run ruff check . && uv run ruff format --check . && uv run pytest -q`.

**Add a new worker service.** Follow
[workers/ conventions](workers.md#conventions-for-a-new-service): its own
directory and toolchain (`uv` for Python, Cargo for Rust), a Dockerfile, a
path-filtered CI job, and types generated from `packages/shared/schema`.
Then add it to `docker-compose.yml` and the `deploy/helm/bbm` chart.

**Change infrastructure.** Read the ADRs first; interfaces between Terraform
stacks, Helm and workflows are pinned there. Run stacks through
`infra/terraform/scripts/tf.sh <stack> <env> <cmd>`, and see
[infra/terraform/README.md](../infra/terraform/README.md) and
[deploy/helm/README.md](../deploy/helm/README.md).

### Where to document a change

| You changed                     | Update                                              |
| ------------------------------- | --------------------------------------------------- |
| An API route or env var         | [docs/api.md](api.md)                               |
| A web page, mock or wallet mode | [docs/web.md](web.md)                               |
| A shared schema                 | [docs/shared.md](shared.md)                         |
| A contract                      | [docs/contracts/overview.md](contracts/overview.md) |
| A test tier or command          | [tests/README.md](../tests/README.md)               |
| An architectural decision       | a new ADR in [docs/adr/](adr/)                      |
| Commands or conventions         | [CLAUDE.md](../CLAUDE.md) and the root README       |
