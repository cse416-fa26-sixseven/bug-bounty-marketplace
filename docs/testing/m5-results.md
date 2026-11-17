# Milestone 5: testing and integration results

Status as of 2026-11-17. Integration branch `feat/m5-testing`; the final PR into `main` is left
for team review.

Milestone 5 closed the gaps in the test suite rather than starting one: unit, system and
Playwright tiers already existed. A gap survey at the start of the milestone found:

- CI's compose stack started anvil and deployed the contracts, but the API ran without
  `CHAIN_RPC_URL` / `SESSION_SECRET`, so sign-in, funding, cancel, reclaim, disputes and the
  arbiter routes were never registered in any system test.
- The on-chain Playwright specs (`lifecycle`, `features`) were skipped unless `E2E_CHAIN=1`,
  which CI never set. CI ran only `home.spec.ts`.
- No contract test asserted an event, although the API indexer is driven entirely by events.
  No fuzz tests.
- No test produced JUnit XML or coverage, so there was nothing to hand in as "test results".
- Several fixed bugs had no regression test (wei migration re-run, k6 wei payload, the
  "Withdraw" vs "Withdraw stake" selector).

## What was added

| PR   | Branch                              | What                                                                                                                                                                             |
| ---- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #142 | `test/reporting`                    | JUnit XML from vitest, Playwright and pytest; coverage from `@vitest/coverage-v8`, `pytest-cov` and `forge coverage`; all uploaded as CI artifacts ([testing/README](README.md)) |
| #143 | `test/unit-gaps`                    | 157 unit tests: contract events, revert paths and fuzz; API error branches; web components; shared schemas; three regression tests                                               |
| #144 | `test/integration-gaps`             | Chain-mode integration tier: `api-chain` service, SIWE sign-in helpers, `tests/integration/chain-flows.test.ts` (15 tests), run in CI                                            |
| #145 | `test/e2e-chain`                    | Four new on-chain browser specs; the whole on-chain suite runs in CI as the non-blocking `e2e-chain` job                                                                         |
| #146 | `fix/claim-stake-gate`              | Fix for bug M5-1 (below), found by #144                                                                                                                                          |
| #148 | `fix/relock-stake-after-failed-poc` | Fix for bug M5-3 (below), found by #145                                                                                                                                          |

Every PR was reviewed by a fresh reviewer agent (a separate Claude Code sub-agent with no shared context) before merge (correctness, coverage, schema
consistency across packages, no real network calls, scope), and the review findings were
fixed on the branch before merging.

## Results

### Test counts

| Suite                        | Before M5                     | After M5 (incl. #146, #148) | Runs in                          |
| ---------------------------- | ----------------------------- | --------------------------- | -------------------------------- |
| Contracts (`forge test`)     | 101                           | 149 (incl. 5 fuzz)          | `contracts` job                  |
| API (vitest, incl. Postgres) | 549                           | 597                         | `api` job (Postgres service)     |
| Web (vitest + MSW)           | 176                           | 207                         | `web` job                        |
| Shared (vitest)              | 69                            | 121                         | `shared` job                     |
| Analysis worker (pytest)     | 217 + 5 Slither               | unchanged                   | `analysis` job                   |
| System integration           | 25 (chain routes unreachable) | 40 (+15 chain-mode)         | `containers` job                 |
| Regression / smoke           | 7 (6 goldens) / 5             | unchanged                   | `containers` job                 |
| E2E (Playwright)             | 2 in CI (6 by hand)           | 10 in CI                    | `containers` (home), `e2e-chain` |

### Coverage (report only, no thresholds)

| Package         | Lines                  | Notes                                                                                                                                    |
| --------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| contracts       | 100% for each contract | branches: AuditorStaking 100%, DisputeResolution 100%, BountyEscrow 94.6% (35/37), unchanged after the `TransferFailed` tests in 78f9da0 |
| api             | ~89%                   | CI run with Postgres; counts every file under `src/`, not just files a test loaded                                                       |
| web             | ~84%                   | `src/` minus `src/test` and `src/mocks`                                                                                                  |
| shared          | 100%                   | mostly declarative zod schemas                                                                                                           |
| analysis worker | ~95%                   | `pytest --cov=analysis`                                                                                                                  |

Exact per-run numbers are in each CI run's step summary and the `coverage-*` artifacts.

### CI evidence

- Integration-branch CI after #144: [run 43988494932](https://github.com/cse416-fa26-sixseven/bug-bounty-marketplace/actions/runs/43988494932):
  all jobs green; `chain-flows.test.ts` 15/15 in ~41 s against the chain-mode API.
- #145's CI: `e2e-chain` job green on push and pull_request runs (10 tests, ~6.6 min of
  Playwright, ~10.5 min for the job). JUnit: `tests="10" failures="0" skipped="0"`.
- Local runs: chain-mode tier 15/15 three times in a row (~55 s); full on-chain e2e suite
  10/10 on a fresh `stack:demo` (~8 min end to end).
- Nightly Azure integration (`integration-azure.yml`: smoke → integration → e2e → k6 on the
  test AKS cluster) green every night 2026-11-07 → 2026-11-16, on `main` (before the M5 changes).

Artifacts per run (Actions → run → Artifacts): `junit-{web,shared,api,analysis}`,
`coverage-{web,shared,api,analysis,contracts}`, `junit-system-tests`, `junit-e2e-chain`,
`playwright-report`, `playwright-report-chain`.

## Bug summary

Every bug found in M5 (B1–B5 and B17, details under [Bugs found in M5](#bugs-found-in-m5)) and the
earlier ones that testing or review caught (B6–B16, see
[Bugs fixed earlier](#bugs-fixed-earlier-and-how-they-were-caught)).

| Bug ID | Description                                                                                                                                       | Severity | Fix / Status                                                                                 |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------- |
| B1     | (M5-1) Claim route skipped the stake gate, so a zero-stake wallet could lock any bounty for the 10-minute claim window                            | High     | Fixed in #146                                                                                |
| B2     | (M5-2) Race in the new stake gate: a wallet could withdraw its stake between the stake check and the on-chain lock                                | Medium   | Fixed in #146 (stake re-read after the lock lands; lock and claim released if short)         |
| B3     | (M5-3) A failed PoC released the stake lock mid-claim; a withdraw before the next verdict left the finding stuck forever                          | High     | Fixed in #148 (lock held until the claim ends)                                               |
| B4     | (M5-4) Logout only clears the cookie; a copied session cookie stays valid for up to 8 hours                                                       | Medium   | Known limitation (needs a server-side session store)                                         |
| B5     | (M5-5) E2E flake: the stake gate briefly showed "locked" after a role switch, so the test helper staked twice                                     | Low      | Fixed in #145 (helper waits for the profile to settle)                                       |
| B17    | (M5-6) The analysis worker's identity could read every secret in the env Key Vault, including prod's on-chain operator key and the session secret | High     | Fix in review: #150 scopes the worker to `database-url` and `llm-api-key` only (into `main`) |
| B6     | A second proven finding on an already-verified bounty reverted forever (`AlreadyVerified` / `BountyNotOpen`)                                      | High     | Fixed in #127                                                                                |
| B7     | Stake lock released too early (finding pending, dispute won, or another finding still needing it)                                                 | High     | Fixed in #99                                                                                 |
| B8     | Funding and cancel accepted stale or foreign bounties                                                                                             | High     | Fixed in #113                                                                                |
| B9     | SIWE nonce could be replayed, and `AUTH_ORIGIN` was not enforced (the API could also start without it)                                            | High     | Fixed in 9957554 and 8a454dd                                                                 |
| B10    | Re-running the wei migration rescaled stored amounts                                                                                              | High     | Fixed in 4f275dc; regression test added in M5                                                |
| B11    | Sepolia deploy failed on-chain (gas underestimated ~7x); indexer ignored `INDEXER_CONFIRMATIONS`                                                  | Medium   | Fixed in #105                                                                                |
| B12    | Internal RPC URL published to the browser                                                                                                         | Medium   | Fixed in 99135d4                                                                             |
| B13    | Postgres repository tests failing: non-idempotent migrations, claimable-contract listing, expired-claim test                                      | Medium   | Fixed in #44                                                                                 |
| B14    | Demo banner shown in prod against the real API                                                                                                    | Low      | Fixed in #72                                                                                 |
| B15    | E2E payout "Withdraw" selector also matched "Withdraw stake"                                                                                      | Low      | Fixed in #123; regression test added in M5                                                   |
| B16    | k6 load test sent the bounty in ETH instead of wei                                                                                                | Low      | Fixed in #61; regression test added in M5                                                    |

## Bugs found in M5

| ID   | Found by                           | Bug                                                                                                                                                                                                                                                                                                                                 | Status                                                                                                                                                               |
| ---- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M5-1 | Chain-mode integration tier (#144) | `POST /api/auditor/claim` never called the stake gate, so a zero-stake wallet could take the on-chain claim lock and block a bounty for the 10-minute claim window. Throwaway wallets could block every bounty.                                                                                                                     | Fixed in #146                                                                                                                                                        |
| M5-2 | Review of the M5-1 fix             | Check-then-act race in the new gate: between the stake read and the mined `lockSubmission`, the wallet can still `withdraw` (front-run with a higher fee), ending up holding the claim with zero stake. `lockSubmission` itself does not check stake.                                                                               | Fixed in #146 (re-read stake once the lock lands; release lock and claim if short)                                                                                   |
| M5-3 | On-chain e2e tier (#145)           | A failed PoC verdict released the auditor's stake lock while the claim stayed active. The auditor could submit a second PoC on the same claim and withdraw the whole stake before its verdict; `recordVerification` then reverted with `AuditorNotEligible` on every pass and the finding stayed "awaiting sandbox result" forever. | Fixed in #148: a Failed verdict keeps the lock while the claim is held; the lock is released when the claim ends (expiry sweep, payout, lost dispute, cancel/refund) |
| M5-4 | Chain-mode integration tier (#144) | Logout only clears the cookie. Sessions are stateless signed cookies valid for 8 hours, so a copied cookie keeps working until it expires.                                                                                                                                                                                          | Known limitation (needs a server-side session store)                                                                                                                 |
| M5-5 | On-chain e2e run                   | Test-side flake: right after a role switch the stake gate briefly showed "locked" for a staked auditor, so `stakeAndClaim` staked twice and then waited on a button that had gone away.                                                                                                                                             | Fixed in #145 (helper waits for the profile to settle)                                                                                                               |
| M5-6 | Review of the stale PR #125        | `stacks/data/identity.tf` gave the analysis worker _Key Vault Secrets User_ on the whole env vault, which since #124 holds prod's `chain-operator-key` and `session-secret`. The worker runs Slither on untrusted Solidity next to the PoC sandbox.                                                                                 | Fix in review: #150 (into `main`), secret-scoped role assignments for `database-url` and `llm-api-key` only                                                          |

Regression tests now exist for earlier fixes that had none: re-running wei migration 0003
(4f275dc), the k6 payload sending wei (#61), and "Withdraw" vs "Withdraw stake" (#123).

### Bugs fixed earlier, and how they were caught

| Bug                                                                                                                        | Caught by                  | Fix              |
| -------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ---------------- |
| A second proven finding on a bounty that had already verified another reverted forever (`AlreadyVerified`/`BountyNotOpen`) | Production on Sepolia      | #127             |
| Payout "Withdraw" selector also matched "Withdraw stake"                                                                   | Unmocked e2e run           | #123             |
| Postgres repository tests failing: non-idempotent migrations, claimable-contract listing, expired-claim test               | DB integration tests in CI | #44              |
| k6 load test sent the bounty in ETH instead of wei                                                                         | Load test                  | #61              |
| Sepolia deploy failed on-chain (forge 1.3.5 underestimated gas ~7x); indexer ignored `INDEXER_CONFIRMATIONS`               | Sepolia deployment         | #105             |
| Stake lock released too early (finding pending, dispute won, another finding still needing it)                             | Code review                | #99              |
| Funding/cancel accepted stale or foreign bounties                                                                          | Code review                | #113             |
| SIWE nonce replay; `AUTH_ORIGIN` not enforced (the API could start without it)                                             | Code review                | 9957554, 8a454dd |
| Re-running the wei migration rescaled amounts                                                                              | Code review                | 4f275dc          |
| Internal RPC URL published to the browser                                                                                  | Code review                | 99135d4          |
| Demo banner shown in prod against the real API                                                                             | Manual check of prod       | #72              |

## Known limitations and follow-ups

- **Stateless sessions** (M5-4): logout cannot revoke a copied cookie before it expires.
- **Stake checks live only in the API.** `AuditorStaking.lockSubmission` does not check
  eligibility, so the API is the only gate on claims. A contract-level check is the stronger
  fix but needs a redeploy of the Sepolia contracts.
- **With claim locks disabled** there is no on-chain lock, so stake → claim → withdraw is
  possible. PoC and finding submissions still check stake, so the harm is limited to holding
  the claim window.
- **`e2e-chain` is non-blocking** (`continue-on-error`, not in `CI OK`). Make it required once it
  has a stable record.
- **Each chain-mode integration run leaves anvil ~3 h ahead of wall time** on a reused stack;
  use a fresh stack before running `E2E_CHAIN=1` specs (see [tests/README](../../tests/README.md)).
- **Local stacks share the compose project name `bbm`**, so `stack:demo` from one worktree
  tears down another's stack. Use `-p <name>` for parallel stacks.
- **After a failed PoC the stake stays locked until the claim lapses** (10 minutes), so the
  auditor can retry on the same claim; it is then released by the keeper's expiry sweep (M5-3 fix).
- **Follow-ups from the M5-3 review:** a PoC submitted within milliseconds of claim expiry can
  race the expiry sweep (`submitPoc` does not lock the contract row); and a lost dispute can
  release the lock while the claim is still active, so if that unlock is retried later by the
  keeper the withdraw-then-resubmit window reopens.
- **No coverage thresholds** yet; numbers are report only.

## Reproducing

```sh
pnpm -r test                                   # unit (no stack)
cd contracts && forge test && forge coverage --report summary

pnpm stack:ci && pnpm stack:ci-chain           # compose stack + chain-mode API on :3002
BBM_CHAIN=1 BBM_CHAIN_API_URL=http://localhost:3002 pnpm test:integration
pnpm test:regression && pnpm test:smoke

scripts/ci-e2e-chain.sh                        # fresh stack:demo + full on-chain Playwright suite
```

Each end-to-end and chain integration scenario, with expected and actual results, is listed in
[m5-test-cases.md](m5-test-cases.md).

See [tests/README.md](../../tests/README.md) for environment variables and per-tier details, and
[testing/README.md](README.md) for where the JUnit and coverage files come from.
