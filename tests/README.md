# System tests (`@bbm/system-tests`)

These suites run against a **running** stack: `pnpm stack:up` locally, the
compose stack in CI, or an Azure environment. Package-level unit tests stay
next to their code.

This package has no `test` script on purpose. That means `pnpm -r test` and
`pnpm test` never need a stack. You run each tier explicitly.

## Test tiers

| Tier                   | Where                                                                                               | Runner                                                                        | When in CI                                                                                                                                      | Network                                                                           |
| ---------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| **Unit**               | `apps/*/src/**/*.test.ts(x)`, `packages/shared`, `contracts/test` (forge), `workers/analysis/tests` | vitest (+ MSW in `apps/web`), `forge test`, pytest                            | `ci.yml` per-package jobs, on every PR (path-filtered)                                                                                          | None. HTTP is mocked (MSW / `app.inject`), and pytest blocks sockets.             |
| **DB integration**     | `apps/api/src/**/pg-repository.test.ts`                                                             | vitest                                                                        | `ci.yml` `api` job, with a `postgres` service container (`DATABASE_URL`)                                                                        | Local Postgres only. Skipped when `DATABASE_URL` is unset.                        |
| **System integration** | `tests/integration/`                                                                                | vitest project `integration`                                                  | `ci.yml` `containers` job, against the compose stack. Also `integration-azure.yml`, against a CI-run namespace on the test AKS cluster.         | Only the stack under test (`BBM_*` URLs). No third-party calls.                   |
| **Regression**         | `tests/regression/` (API goldens), `contracts/.gas-snapshot`, `packages/shared/schema` drift        | vitest project `regression`, `forge snapshot --check`, `git diff --exit-code` | `ci.yml`: `containers` job (goldens), `contracts` job (gas), `shared` job (schema)                                                              | Stack under test only (goldens). The other two checks are offline.                |
| **Smoke**              | `tests/smoke/`                                                                                      | vitest project `smoke`                                                        | `ci.yml` `containers` job. In Azure: after every CI-run / preview namespace deploy and after `deploy.yml` / `env-power resume` on staging/prod. | Stack under test only. Read-only unless `BBM_SMOKE_WRITE=1` (never set for prod). |
| **E2E**                | `tests/e2e/`                                                                                        | Playwright (chromium)                                                         | `ci.yml` `containers` job (compose stack). Also `integration-azure.yml`, against the CI-run namespace's host                                    | Browser → web under test only                                                     |
| **Load**               | `tests/load/`                                                                                       | k6 (`grafana/k6:2.3.0`)                                                       | `integration-azure.yml` nightly, or when dispatched with `load: true`                                                                           | API under test only. Never prod, because setup writes a row.                      |

## Running locally

```sh
pnpm install
pnpm stack:up                  # db, api, web, analysis, anvil (waits for healthchecks)
pnpm stack:deploy-contracts    # deploys contracts to anvil (needed by integration/chain)

pnpm test:integration
pnpm test:regression
pnpm test:smoke                # < 10s
pnpm test:e2e                  # first time: pnpm --filter @bbm/system-tests exec playwright install --with-deps chromium

docker run --rm -i --network host -e BASE_URL=http://localhost:3001 \
  grafana/k6:2.3.0 run - < tests/load/api-baseline.js   # see tests/load/README.md

pnpm stack:down
```

The root `test:*` scripts forward to
`pnpm --filter @bbm/system-tests run <script>`.

### On-chain lifecycle (manual)

`e2e/lifecycle.spec.ts` drives the full on-chain lifecycle in the browser:
payout (fund, stake, claim, passing PoC, Verified, Paid after the challenge
window, withdraw) and dispute (disputed, arbiter rules against the auditor,
Rejected, stake slashed). It is skipped unless `E2E_CHAIN=1`, because it needs
the chain demo stack and the web app in live chain mode, which CI does not
start. The two tests share one auditor account and run in order.

```sh
pnpm stack:demo                # fresh database and chain, 60-second challenge window
NEXT_PUBLIC_API_MOCKING=enabled NEXT_PUBLIC_LIVE_PIPELINE=enabled NEXT_PUBLIC_LIVE_CHAIN=enabled \
  API_INTERNAL_URL=http://localhost:3001 pnpm --filter @bbm/web dev
E2E_CHAIN=1 pnpm test:e2e -- lifecycle   # about 3 minutes
pnpm demo:lifecycle            # the same two paths from the command line; prints LIFECYCLE OK
```

### Environment variables

The defaults match the compose ports, so you only set these to target
something else.

| Var                    | Default                      | Used by                                                          |
| ---------------------- | ---------------------------- | ---------------------------------------------------------------- |
| `BBM_API_URL`          | `http://localhost:3001`      | integration, regression, smoke, plus the globalSetup health wait |
| `BBM_WEB_URL`          | `http://localhost:3000`      | integration (proxy), smoke, e2e (`baseURL`)                      |
| `BBM_ANALYSIS_URL`     | `http://localhost:8000`      | integration, smoke                                               |
| `BBM_RPC_URL`          | `http://localhost:8545`      | integration/chain                                                |
| `BBM_DEPLOYMENTS_FILE` | `.ci/deployments/31337.json` | integration/chain. The tests skip when the file is missing.      |
| `BBM_SKIP_ANALYSIS`    | unset                        | `1` skips analysis checks. Analysis is internal-only on AKS.     |
| `BBM_SMOKE_WRITE`      | unset                        | `1` adds smoke's create+read round-trip (CI, non-prod deploys)   |
| `BBM_SMOKE_READONLY`   | unset                        | `1` forces read-only even when `BBM_SMOKE_WRITE=1`               |
| `BBM_WAIT_MS`          | `30000`                      | How long globalSetup waits for `GET /health`                     |
| `CI`                   | unset                        | Playwright: 1 retry, `forbidOnly`, GitHub reporter               |

The vitest globalSetup fails fast with a clear message if the API isn't
reachable. Without it, every test would time out separately.

## Updating goldens

API goldens live in `tests/regression/__golden__/`. Ids and timestamps are
normalized to placeholders and keys are sorted. When an API change is
intentional:

```sh
pnpm stack:up
pnpm --filter @bbm/system-tests test:regression -u
git diff tests/regression/__golden__   # review: this is what clients see
```

Commit the updated goldens in the same PR as the API change. In CI
(`CI=true`) a missing golden is a failure; it is never written.

The other regression gates have their own update commands:

- **Gas snapshot:** run `cd contracts && forge snapshot` and commit
  `contracts/.gas-snapshot`.
- **Shared JSON schema:** run `pnpm --filter @bbm/shared gen:schema` and
  commit `packages/shared/schema/*.json`.

## Pointing the suites at Azure

The Azure workflows don't build anything test-specific. They deploy the app,
export the `BBM_*` env with its URL and run the same commands. CI runs and PR
previews are namespaces on the test AKS cluster, deployed by
`_ephemeral-env.yml` (see `docs/devops/env-lifecycle.md`, "The test env"):

- **`integration-azure.yml`** (pipeline test)
  1. Deploys namespace `run-<run_id>-<attempt>`, resuming the test cluster
     first if it is paused.
  2. Exports `BBM_API_URL` and `BBM_WEB_URL`, both
     `https://run-<run_id>-<attempt>.test.<zone>` (web, `/api` and `/health`
     share one host), and `BBM_SKIP_ANALYSIS=1`. Analysis has no external
     ingress. There is no chain, so the chain tests skip on the missing
     deployments file.
  3. Runs `pnpm test:smoke` (with `BBM_SMOKE_WRITE=1`), `pnpm test:integration`
     and `pnpm test:e2e`. Nightly, or when dispatched with `load: true`, it
     also runs k6 with `BASE_URL=$BBM_API_URL`.
  4. Always deletes the namespace, unless dispatched with `keep_env`.
- **`preview.yml`** (namespace `pr-<n>`, mocked web) runs `pnpm test:smoke`
  against `https://pr-<n>.preview.<zone>` with `BBM_SMOKE_WRITE=1` and
  `BBM_SKIP_ANALYSIS=1`.
- **`deploy.yml` / `env-power.yml resume`** (AKS staging/prod) run
  `pnpm test:smoke` with `BBM_API_URL` / `BBM_WEB_URL` set to the ingress
  host (`https://<env>.<zone>`). Non-prod sets `BBM_SMOKE_WRITE=1`; all AKS
  runs set `BBM_SKIP_ANALYSIS=1`.

The CI commands are:

```sh
# smoke (any env)
BBM_API_URL=... BBM_WEB_URL=... BBM_SKIP_ANALYSIS=1 [BBM_SMOKE_WRITE=1] \
  pnpm --filter @bbm/system-tests run test:smoke

# e2e (CI caches ~/.cache/ms-playwright per Playwright version; the script
# only falls back to apt for system libs if Chromium can't launch)
tests/e2e/install-browser.sh
CI=true BBM_WEB_URL=... pnpm --filter @bbm/system-tests run e2e
# upload tests/e2e/playwright-report/ as an artifact (if: always())

# load
docker run --rm -i -e BASE_URL="$BBM_API_URL" grafana/k6:2.3.0 run - < tests/load/api-baseline.js
```
