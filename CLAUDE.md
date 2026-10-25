# CLAUDE.md

Guidance for Claude Code (and human contributors) working in this repo.

## Project

AI-assisted smart contract security and bug-bounty marketplace. See
`README.md` for the full product description and finding-status lifecycle
(`Flagged → Submitted → Verified → Disputed/Rejected → Paid`).

## Commands

```sh
pnpm install              # install all workspace deps

pnpm -r lint               # fan out `lint` to every package that has it
pnpm -r typecheck          # fan out `typecheck`
pnpm -r test               # fan out `test` (unit tests only, no stack needed)
pnpm -r build              # fan out `build`

pnpm --filter @bbm/api dev        # run the Fastify API with hot reload
pnpm --filter @bbm/api typecheck
pnpm --filter @bbm/api test       # pg tests run only with DATABASE_URL set
pnpm --filter @bbm/api build

pnpm --filter @bbm/shared typecheck
pnpm --filter @bbm/shared gen:schema   # regenerate packages/shared/schema/*.json; commit it

NEXT_PUBLIC_API_MOCKING=enabled pnpm dev   # web app against the MSW mocks

# Full local stack (docker compose; see README "Running the stack"):
pnpm stack:up                  # build + start db, api, web, analysis, anvil
pnpm stack:deploy-contracts    # deploy contracts to the local anvil
pnpm stack:ci                  # CI variant: prebuilt images, --no-build
pnpm stack:down                # stop + remove volumes

# System tests against a running stack (see tests/README.md):
pnpm test:integration
pnpm test:regression           # -u via `pnpm --filter @bbm/system-tests test:regression -u`
pnpm test:smoke
pnpm test:e2e

# workers/analysis (Python, uv):
cd workers/analysis && uv sync
uv run ruff check . && uv run ruff format --check .
uv run pytest -q
uv run scripts/gen-types.sh    # regenerate pydantic models from shared schema; commit it

# Contracts (Foundry v1.3.5, see docs/contracts/foundry-setup.md):
cd contracts && forge build && forge test
forge snapshot                 # rewrite .gas-snapshot after gas changes; CI runs --check

# Infra (no Azure credentials needed):
infra/terraform/scripts/ci-static.sh   # fmt, validate, terraform test, tflint, shellcheck
helm lint --strict deploy/helm/bbm -f deploy/helm/bbm/values-staging.yaml --set global.image.tag=test
helm template bbm deploy/helm/bbm -n bbm -f deploy/helm/bbm/values-prod.yaml --set global.image.tag=test
helm lint --strict deploy/helm/bbm-platform -f deploy/helm/bbm-platform/values-prod.yaml -f deploy/helm/bbm-platform/ci/prod-values.yaml
docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:1.7.3   # lint workflows

# Azure bring-up / teardown (needs `az login --use-device-code`; see docs/devops/azure-bootstrap.md):
infra/up.sh --subscription <guid> [--zone <zone>] [--location <region>] [--envs test,staging] [--prod] [--dry-run]
infra/down.sh --subscription <guid> (--envs <list> | --all) [--dry-run]
```

`@bbm/system-tests` (`tests/`) has **no `test` script on purpose**, so
`pnpm -r test` never needs a running stack. Run its tiers explicitly.

## Conventions

- **TypeScript strict mode everywhere.** All packages extend the root
  `tsconfig.base.json` (`strict: true`, `esModuleInterop`, `skipLibCheck`,
  `forceConsistentCasingInFileNames`, `target: ES2022`,
  `moduleResolution: bundler` by default — individual packages may override
  module resolution if their runtime requires it. `apps/api` also uses
  `bundler` resolution: `tsc` only typechecks it, and `apps/api/build.mjs`
  bundles it with esbuild into `dist/` for `node dist/index.js`).
- **Conventional Commits** for every commit (`feat:`, `fix:`, `chore:`,
  `docs:`, `refactor:`, `test:`, etc.), small and scoped.
- **pnpm workspaces** cover `apps/*`, `packages/*` and `tests` (the
  `@bbm/system-tests` package). `workers/*` is deliberately excluded — it
  holds non-TypeScript services (Python/Rust) with their own toolchains, not
  pnpm packages.
- Run the relevant `lint` / `typecheck` / `test` / `build` for whatever you
  touched before every commit (for infra: `ci-static.sh`, `helm lint`,
  actionlint).

## Git workflow

- Each milestone has an integration branch cut from `main`: currently
  `feat/m3-devops` (DevOps milestone); previously `feat/m2-foundation`
  (M2 foundation).
- Each sub-branch (e.g. `ci/azure-workflows`, `docs/devops`) is cut from the
  **latest** integration branch — pull before cutting.
- Commit in small Conventional Commits. Lint/typecheck/test/build whatever
  you touched before each commit; only commit when it's green.
- Open a PR into the integration branch with `gh pr create`. Wait for CI,
  address reviewer findings.
- Before merging, **always run a fresh reviewer sub-agent on the PR diff**
  (not reused context) checking for: correctness and test coverage, schema
  consistency across packages, accidental real network calls (should be
  mocked), and scope creep beyond the sub-branch's stated purpose.
- Merge with `gh pr merge --merge --delete-branch` — a real merge commit, not
  a squash — so sub-branch history is preserved on the integration branch.
- Pull the integration branch before cutting the next sub-branch.
- When the whole milestone is done, open the final PR
  `<integration branch>` → `main`, but **do not merge it** — it's left for
  team review.

## Infra conventions

- **Terraform layout** (`infra/terraform/`): reusable `modules/`, one
  `stacks/<stack>` per layer (`bootstrap`, `global`, `data`, `compute`),
  per-env inputs in `envs/<env>/` (`test`, `staging`, `prod`, all on AKS).
  Names and tags come from `modules/naming`; bootstrap owns every resource
  group and every public DNS zone (the parent zone and the per-env child
  zones). Interfaces between stacks, Helm and workflows are pinned in
  `docs/adr/0001-azure-environment-topology.md` and
  `docs/adr/0002-aks-everywhere-and-azure-dns.md` — change them there first.
- **`dns_zone_name` (`envs/global/bootstrap.tfvars`) is the only domain
  input.** Never hardcode a domain or subscription; `infra/up.sh` writes
  them into the tfvars.
- **Run stacks through `scripts/tf.sh <stack> <env> <cmd>`**, which picks
  the var-file, backend config and state key (`TFSTATE_RG` /
  `TFSTATE_ACCOUNT` override the committed backend files).
- **No externally supplied secrets in Terraform state.** Terraform creates
  vaults; values like `llm-api-key`, the Sepolia RPC URL and deployer key are
  set with `az keyvault secret set` (see `docs/devops/azure-bootstrap.md`).
- **OIDC only.** Workflows authenticate to Azure with GitHub federated
  credentials per GitHub Environment; never add cloud secrets to GitHub.
- **Azure workflows are gated on repo vars** (`vars.AZURE_SUBSCRIPTION_ID`,
  `vars.ACR_NAME`, `vars.AZURE_LOCATION`, `vars.AZURE_LOCATION_ABBR`, ...) and skip green until
  bootstrap has set them.
- **Regions** (ADR 0002 §7–8): the home region (`location` / `location_abbr` in
  `envs/global/*.tfvars`, `northcentralus` / `ncus`) holds tfstate and the shared layer. Each env
  has its own region in `envs/<env>/{data,compute}.tfvars`, mirrored in `env_locations`
  (bootstrap/global): test `cac` (canadacentral, arm64 `Standard_B4ps_v2`), staging `dke`
  (denmarkeast) and prod `ncus` (northcentralus), both x86 `Standard_B4as_v2`, because Azure for
  Students allows five regions at 6 vCPU each and only ncus/dke offer an x86 4 vCPU B-series
  size. `infra/up.sh --location` / `--env-location <env>=<region>` rewrite them; the region →
  code map lives in `modules/naming`. Workflows and scripts build names such as
  `rg-bbm-<env>-data-<abbr>` from Environment-level `vars.AZURE_LOCATION_ABBR` or
  `infra/terraform/scripts/env-region.sh <env>`, never from literals.
- **`ci.yml` stays Azure-free**, so `CI OK` never depends on cloud
  credentials, quota or uptime. Anything that needs Azure goes in its own
  workflow.
- **Helm values layering:** `values.yaml` (safe, kind-friendly defaults) →
  `values-<env>.yaml` (test/staging/prod switches and sizes) → generated
  `values-infra.yaml` (`tf.sh compute <env> output -raw helm_values`, never
  committed) → `--set global.image.tag=sha-<7>`. Env files never hardcode
  infra values.

## Sub-agent rules

- **Explore before big changes.** Read the relevant directories/files before
  scaffolding or refactoring anything non-trivial.
- **Foundation branches are sequential** (monorepo scaffold → shared schemas →
  web shell/mocks → CI), each depending on the last. Do them in order, one at
  a time.
- **Flow branches (developer / auditor / arbiter) run in parallel**, once the
  foundation is in place. Each flow gets its own git worktree and its own
  sub-agent, split by mock handler area:
  - `apps/web/src/mocks/handlers/{developer,auditor,arbiter}.ts` plus a shared
    `index.ts` that composes them.
  - The mock DB is split the same way (per-flow data/fixtures module).
  - Each flow agent may only touch files and routes under its own area. If a
    flow needs a change to shared code (shared schemas, the shared mock DB
    index, shared UI components), it **reports the need back** instead of
    editing shared files directly, so a human/coordinator can apply it once
    and avoid merge conflicts between the parallel worktrees.
- **Always run a fresh reviewer sub-agent on the PR diff before merging**
  (see Git workflow above) — this applies to every branch, foundation or
  flow.

## Adding a new Python service under `workers/`

1. Create `workers/<service-name>/` with its own `pyproject.toml` managed by
   `uv`.
2. Add a `Dockerfile` in that directory.
3. Add a path-filtered CI job that only triggers on changes under
   `workers/<service-name>/**` or `packages/shared/schema/**`.
4. Generate Python types from the JSON Schema files in
   `packages/shared/schema/*.json` using `datamodel-code-generator`, as part
   of that service's build step.

## Adding a new Rust service under `workers/`

1. Create `workers/<service-name>/` with its own `Cargo.toml`.
2. Add a `Dockerfile` in that directory.
3. Add a path-filtered CI job scoped to `workers/<service-name>/**` or
   `packages/shared/schema/**`, using `dtolnay/rust-toolchain` and
   `Swatinem/rust-cache`, running `cargo fmt --check`, `cargo clippy`, and
   `cargo test`.
4. Generate Rust types from `packages/shared/schema/*.json` using `typify`.
