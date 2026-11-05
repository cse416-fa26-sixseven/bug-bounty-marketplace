# ADR 0005: Operator key trust model

- **Status:** Accepted
- **Date:** 2026-10-24 (revised 2026-11-04: per-environment deployments, an api-only chain
  vault, deferred indexer check and `pocHash`; 2026-11-05: renumbered from the draft 0002, Helm
  chain mode ships off)
- **Scope:** `contracts/src/**`, `apps/api/src/chain/**`, `apps/api/src/indexer/**`, `infra/terraform/modules/keyvault/**`

## Context

The API holds one platform key, the **operator**, and signs the actions only the platform can
take: recording a submission, recording a sandbox verdict, locking and releasing an auditor's
claim stake, and paying out after the challenge window. Every other money-moving action
(funding, staking, disputing, ruling, refunding, withdrawing) is signed by the user's own account
in the browser.

We chose backend-submitted verdicts over an auditor-carried EIP-712 authorization because it keeps
the contracts small and keeps the sandbox result off the auditor's machine. The cost is that one
key can assert "this PoC reproduced", so this ADR states what that key can and cannot do.

## Decision

### 1. What the operator key can call

The operator is a single address fixed at deployment. It is checked with `onlyOperator`.

| Contract | Operator-only function | Effect |
| --- | --- | --- |
| `BountyEscrow` | `recordSubmission(contractId)` | Counts a submission; blocks `deleteBounty`. |
| `BountyEscrow` | `recordVerification(contractId, findingId, auditor)` | Marks the first verified finding and starts the challenge window. The auditor must be staked. Only one verification per bounty. |
| `BountyEscrow` | `payout(contractId, findingId, auditor)` | Credits the bounty to the **already recorded** verified auditor, only after the challenge window and only if not frozen. |
| `AuditorStaking` | `lockSubmission` / `unlockSubmission(auditor)` | Blocks or allows the auditor's stake withdrawal while a claim is open. |
| Both | `bindDisputeResolution(dr)` | One-time wiring at deploy (`AlreadyBound` afterwards). |

The operator **cannot**:

- Send escrowed ETH to an arbitrary address. `payout` only credits `verifiedAuditor`, and the
  auditor withdraws with their own key.
- Refund, delete or re-fund a bounty (`onlyDeveloper`).
- Open, rule on or lapse a dispute. Ruling is `onlyArbiter`, a separate key.
- Slash a stake or change reputation (`onlyDisputeResolution`).
- Change the challenge window, refund delay, stake size or slash percentage. These are immutable
  or constant.
- Touch an auditor's credited `pendingPayouts`.

**Deployment requirement:** `OPERATOR` and `ARBITER` must be different keys.
`Deploy.s.sol` defaults both to the broadcaster, which is fine on Anvil but not on Sepolia or
production. A shared key would let one compromise both verify and rule. The Sepolia deploy
workflow therefore takes the arbiter address as a required input; the arbiter is a team member's
own wallet.

**The operator is the deployer.** `bindDisputeResolution` is `onlyOperator` and runs inside the
deploy script, so `Deploy.s.sol` requires `OPERATOR == deployer`. Each environment's operator key
is therefore also the key that deployed that environment's contracts.

**One deployment per environment.** Staging and prod each get their own Sepolia deployment and
their own operator key. A shared deployment would have two APIs sending from one key, so their
nonces would collide, and a compromise of one environment would reach the other. The ephemeral
`test` environment has no chain for now; an in-cluster Anvil chain with the public Anvil keys,
like the local `pnpm stack:demo`, is future work.

### 2. Where the key is stored

| Environment | Storage |
| --- | --- |
| Local / CI | Anvil test account #0 in `docker-compose.chain.yml`. A public, valueless key; never reused elsewhere. |
| Ephemeral `test` env | No chain yet. When it gets an in-cluster Anvil chain, the same public Anvil keys as plain test-only secrets. |
| Sepolia staging / prod | Secret `operator-private-key` in that environment's **chain vault** (`kv-bbm-<stg\|prd>c-<sfx>`, see below), generated and set by hand with `az keyvault secret set`, as is already done for `llm-api-key`. It is never in Terraform state, the repo or CI logs. The Sepolia RPC URL is set by hand next to it as `chain-rpc-url` (env identities cannot read the shared vault). The contracts deploy workflow reads both to deploy, then writes the deployment file to the same vault as `chain-deployment`. On AKS the secrets reach the API pod through the `bbm-kv-chain` SecretProviderClass, which authenticates as the API's workload identity. |

The key is loaded only by `apps/api/src/chain/config.ts`, and the API rejects a malformed key at
startup. The arbiter key is a person's wallet and is never stored on the platform.

**An api-only chain vault.** The analysis service sits next to the PoC sandbox and has *Key
Vault Secrets User* on the whole env vault, so it must never share a vault with the operator key.
The data stack therefore creates a second vault per environment, the chain vault, and grants
*Secrets User* on it to the `api` identity only (`infra/terraform/stacks/data/identity.tf`):

| Vault | Secrets | Readers |
| --- | --- | --- |
| env vault `kv-bbm-<env>-<sfx>` | `database-url`, `llm-api-key`, `pg-admin-password` | `api`, `worker` |
| chain vault `kv-bbm-<env>c-<sfx>` | `operator-private-key`, `chain-rpc-url`, `chain-deployment`, `session-secret` | `api` |

Per-secret role assignments were rejected: a role can only be assigned on a secret that already
exists, and these are set by hand after Terraform runs. Creating them from Terraform would either
copy their values into state or overwrite a value already set.

Moving signing into a separate signer process or a Key Vault HSM key, so the general API process
never holds the raw key, is future work.

### 3. What a compromised key can do, and what limits it

| Attack | Limit |
| --- | --- |
| **False verification:** mark a bogus finding Verified for a staked auditor (possibly the attacker's own account) on an open bounty with at least one submission and nothing verified yet. | Payout cannot happen until the **challenge window** passes (default 3 days). During it the developer can `openDispute`, which freezes the bounty. The arbiter (a different key) rules. If the auditor loses, the verification is cleared and **50% of the auditor's stake is slashed to the developer**. The attacker therefore risks the 0.1 ETH stake they had to post, and the bounty becomes verifiable again. |
| **Early or redirected payout.** | Not possible: `payout` checks the window, the frozen flag and the recorded auditor. |
| **Grief stakes:** `lockSubmission` an auditor so they cannot withdraw, or `recordSubmission` to stop a developer deleting a bounty. | No funds go to the attacker. The developer can still `refund` after the deadline plus the refund delay, as long as no finding is verified. **Locked stakes stay locked:** only the operator can call `unlockSubmission`, and a redeploy does not touch the old `AuditorStaking`. While the team still holds the key it can unlock them, but the attacker can lock them again. |
| **Unlock to dodge slashing:** `unlockSubmission` lets an auditor withdraw stake while a dispute is pending, so the slash takes less. | The ruling still clears the verification, so no bounty is paid out. Only the penalty is lost. |
| **Denial of service, or a lost key:** no more verdicts, payouts or unlocks. | Credited payouts are withdrawn by auditors directly. Developers can refund unverified bounties after the deadline. **A bounty with a verified finding is stuck:** `refund` reverts with `AlreadyVerified` and only the operator can `payout`. |

Every operator action emits an event (`SubmissionRecorded`, `FindingVerified`, `PayoutCredited`,
`SubmissionLocked`, `SubmissionUnlocked`), so a forged verdict is visible on-chain. **The platform
does not detect one yet.** The event indexer treats the chain as authoritative. A
`FindingVerified` for a real finding is applied to the database as Verified, even if no PoC passed
for it. One for an unknown finding is held as pending without a warning; a warning is logged only
when `pendingMaxAgeBlocks` is set (off by default) and the log is dropped.

**Residual risks:**

1. Protection relies on the developer disputing within the window. A developer who isn't watching
   can lose the bounty to a false verification. Follow-up: in the indexer, check each
   `FindingVerified` against a passing row in `poc_submissions`; if there is none, alert and
   notify the developer.
2. If the arbiter misses the ruling window (3 days), `lapse` resolves **in the auditor's favour**.
   This default is confirmed: the sandbox did reproduce the PoC, and the arbiter chose not to
   rule. A compromised operator plus an inactive arbiter means the false verification stands.
3. The verdict is not bound to a PoC hash on-chain (`recordVerification` takes only
   `findingId`). Follow-up: add `pocHash` to the call and the `FindingVerified` event so a
   dispute can prove which PoC was verified.

### 4. Why there is no key rotation

`operator` is `immutable` in `BountyEscrow` and `AuditorStaking`, by choice:

- **A rotation function is itself an attack surface.** If the operator could call
  `setOperator`, a stolen key would rotate itself to the attacker and lock the platform out. Safe
  rotation needs a second, colder **owner** key (e.g. OpenZeppelin `Ownable2Step` or
  `AccessControl` with an admin role), plus storage, procedures and tests for that key as well.
  That is more trust machinery than this semester's scope.
- **Immutability makes the audit simple.** The set of addresses that can ever act is fixed at
  deployment and visible on-chain.
- **Recovery path:** on compromise, (1) stop the API's chain module, (2) deploy fresh contracts
  with a new operator key, (3) point the API and indexer at the new `deployments/<chainid>.json`,
  (4) have developers dispute any suspicious verification in the old contracts during its
  challenge window, and refund or re-fund the rest on the new contracts. Escrowed ETH can't be
  redirected by the operator, but it isn't all recoverable on its own. Verified bounties need an
  operator `payout`, and locked stakes need an operator `unlockSubmission`, both on the old
  contracts. While the team still holds the old key, it does these as part of the migration. If
  the key is lost, those funds stay stuck. This is the main cost of having no rotation.

On a testnet with test ETH, this cost is acceptable. Before real funds, we would add an owner-gated
`AccessControl` operator role with a timelock on changes.

## Consequences

- One platform key is trusted to assert sandbox results, but it cannot move funds to itself or
  anyone it chooses. Its worst cases are a false verification, which needs a dispute to undo, and
  stakes or verified bounties frozen by griefing or by losing the key.
- The challenge window and the separate arbiter key are the safety net. Their parameters (3-day
  window, 3-day ruling window, 50% slash) are part of the security design, not just product
  choices.
- Before Sepolia: separate `OPERATOR` and `ARBITER` (a required workflow input), one deployment
  and operator key per environment, an api-only chain vault for the key, and Helm wiring. All of these are part of this decision.
- Helm's `chain.enabled` ships `false` in staging and prod and is turned on per env once its
  chain vault holds a real operator key, RPC URL and deployment, so a deploy never fails on a
  missing secret.
- **Deferred:** the indexer's forged-verdict check (residual risk 1) and `pocHash` on verdicts
  (residual risk 3). Sepolia escrows only test ETH, and the challenge window plus dispute already
  bound the damage, so these wait until before any deployment that holds real funds.
