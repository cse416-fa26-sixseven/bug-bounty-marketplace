# BountyGuard User Guide (draft)

> **Status: draft for Milestone 5.** This guide will be finalized for Milestone 6.
> Screenshot placeholders are marked _📷 Screenshot_ and will be filled in then.

## Contents

1. [Introduction](#1-introduction)
2. [Installation / Getting Started](#2-installation--getting-started)
3. [Usage Walkthrough](#3-usage-walkthrough)
4. [FAQ / Troubleshooting](#4-faq--troubleshooting)

---

## 1. Introduction

### What the system does

BountyGuard is an AI-assisted smart contract security and bug-bounty marketplace.
It connects people who write Solidity contracts with security researchers who
can prove those contracts are vulnerable, and pays researchers only for proof.

1. A **developer** uploads a Solidity contract and funds a bounty, which is held
   in on-chain escrow.
2. **Slither** runs static analysis on the contract. An **LLM explains each
   finding** in plain English. The explanations are advisory: they never change a
   finding's status or the payout.
3. An **auditor** stakes a deposit, claims the contract (exclusively, for a
   limited time) and submits a **Foundry proof-of-concept (PoC)** test.
4. A **sandbox** re-runs the PoC. Only a passing PoC marks a finding
   **Verified**.
5. If the developer does not dispute the Verified finding within the
   **challenge window**, escrow pays the auditor. The first verified PoC wins
   and the bounty closes.
6. If the developer disputes, an **arbiter** rules. A losing auditor's stake is
   slashed (half of it).

Auditors can also mark AI findings as **false positives**, or **report a
vulnerability Slither missed** together with the PoC that proves it.

### Who it is for

| Role          | Who                                                     | What they do in the app                                                    |
| ------------- | ------------------------------------------------------- | -------------------------------------------------------------------------- |
| **Developer** | Teams shipping smart contracts                          | Upload contracts, fund bounties, read findings, dispute, reclaim or cancel |
| **Auditor**   | Independent security researchers                        | Stake, claim contracts, submit PoCs, report new findings, withdraw payouts |
| **Arbiter**   | A trusted platform admin (the address set at deployment) | Review disputes and rule for or against the auditor                        |

### Finding lifecycle

Every finding moves through these statuses:

```
Flagged ──► Submitted ──► Verified ──► Paid
                │             │
                ▼             ▼
            Rejected      Disputed ──► Paid      (arbiter rules for the auditor)
                                  └──► Rejected  (arbiter rules against; stake slashed)
```

| Status        | Meaning                                                                    |
| ------------- | -------------------------------------------------------------------------- |
| **Flagged**   | Slither reported it; nobody has proven it yet                              |
| **Submitted** | An auditor uploaded a PoC; the sandbox is running it                       |
| **Verified**  | The PoC passed in the sandbox; the challenge window is open                |
| **Disputed**  | The developer challenged the verified finding; waiting for the arbiter     |
| **Rejected**  | The PoC failed, or the arbiter ruled against the auditor                   |
| **Paid**      | Escrow paid the auditor                                                    |

An auditor-reported finding (one Slither missed) starts at **Submitted** and then
follows the same path.

---

## 2. Installation / Getting Started

There are three ways to use BountyGuard. Pick the one that fits.

| Mode                    | What is real                                                  | Good for                         |
| ----------------------- | ------------------------------------------------------------- | -------------------------------- |
| **A. Demo (mocked)**    | Only the UI. Analysis, sandbox, wallets and payments are simulated. | A quick tour; no setup beyond Node |
| **B. Local full stack** | Everything: API, Postgres, Slither + LLM, sandbox, a local Anvil chain | End-to-end demos and testing     |
| **C. Hosted (Sepolia)** | Everything, on the Sepolia testnet, with your own MetaMask wallet | Using the deployed staging/prod site |

### Prerequisites

- **Node 22** (see `.nvmrc`) and **pnpm 9** (`corepack enable`)
- For mode B: **Docker** with Compose ≥ 2.24, plus `curl` and `jq`
- For mode C: a browser with **MetaMask** and some **Sepolia test ETH**
  (from a faucet)

Clone the repository with its submodules:

```sh
git clone --recurse-submodules <repo-url>
cd bug-bounty-marketplace
nvm use
corepack enable
pnpm install
```

### A. Demo mode (no backend)

```sh
NEXT_PUBLIC_API_MOCKING=enabled pnpm dev
```

Open <http://localhost:3000>. A "Demo environment" banner shows you are on
simulated data. Every role has a fixed mock identity, so there is no wallet to
connect. **Reloading the page resets all demo data and timers.**

_📷 Screenshot: overview page in demo mode, with the demo banner and role selector._

### B. Local full stack (real analysis and chain)

```sh
pnpm stack:demo
NEXT_PUBLIC_API_MOCKING=disabled API_INTERNAL_URL=http://localhost:3001 \
  pnpm --filter @bbm/web dev
```

`pnpm stack:demo` starts Postgres, a local Anvil chain, deploys the contracts
(with a 60-second challenge window), and starts the API and the analysis
service with the PoC sandbox. Open <http://localhost:3000>.

- Each role (developer, auditor, arbiter) uses its own pre-funded Anvil test
  account. Switching roles signs you in to the API automatically (Sign-In with
  Ethereum); there is no wallet popup.
- No real funds are involved. Data lasts until you restart the demo stack.
- For real LLM explanations, put `LLM_ENDPOINT`, `LLM_MODEL` and `LLM_API_KEY` in
  `workers/analysis/.env`. Without them, explanations fall back to Slither's own
  text.

To check the stack works without the browser, run `pnpm demo:lifecycle`; it
should print `LIFECYCLE OK`.

### C. Hosted site on Sepolia

Open the staging or prod URL your team shares (`https://staging.<domain>` or
`https://prod.<domain>`).

1. Install MetaMask and get Sepolia ETH from a faucet. An auditor needs the
   required stake (**0.1 ETH**) plus gas.
2. Click **Connect wallet** in the header. MetaMask asks you to connect, to
   switch to Sepolia if needed, and to sign a Sign-In with Ethereum message.
3. Your connected account is your identity in every role. The role selector only
   chooses which workspace you see. To act as a different person, switch
   accounts in MetaMask and connect again.

_📷 Screenshot: header with Connect wallet, role selector and the MetaMask sign-in prompt._

### The Getting started page

Every mode has a **Getting started** page (`/guide`) that summarizes each role's
steps for the current environment (stake amount, challenge window) and links to
two sample files:

- **Download sample contract** — a deliberately vulnerable vault contract
- **Download sample PoC** — a Foundry test that exploits it

These are the quickest way to try the full flow.

---

## 3. Usage Walkthrough

The walkthrough follows one bounty from upload to payout, then the dispute path.
Use the **role selector** in the header (or the sidebar) to switch between
developer, auditor and arbiter.

### 3.1 Developer: submit a contract and fund a bounty

1. Switch to **Developer** and open **Submit a contract** (`/submit`).
2. **01 / Contract source:** choose a single `.sol` file, at most **100 KB**
   (use the sample contract to start).
3. **02 / Bounty terms:** enter a bounty amount greater than zero, pick a
   currency, and choose a **deadline in the future**.
4. Click **Submit contract**. You land on the contract's page.

_📷 Screenshot: Submit a contract form with a file chosen and bounty terms filled in._

5. Wait for analysis. The page shows **Analysis still running...** and updates
   automatically. Findings appear in about 3 seconds in demo mode and in under a
   minute on a real stack.
6. When analysis finishes, click **Fund bounty** to move the bounty into escrow
   (on a real chain this is a transaction you sign). Funding opens only after the
   analysis succeeds, so a contract that does not compile is never funded.

_📷 Screenshot: contract page with Slither findings, AI explanations and the Fund bounty button._

**Reading findings.** Each finding card shows its severity, Slither's detector
output, the AI explanation, its current status and a **status history**. You can
add a **developer note** to a finding (for example, "known issue, fixed in v2").

**Your contracts** (`/contracts`) lists everything you have submitted, with a
search box and each contract's status.

**Other developer actions** on the contract page:

| Button                     | When                                                   | Effect                                      |
| -------------------------- | ------------------------------------------------------ | ------------------------------------------- |
| **Cancel contract**        | While the contract is still **Open**                   | Closes the contract and its bounty          |
| **Reclaim bounty**         | After the deadline, with no finding Submitted, Verified or Disputed | Returns the escrowed bounty to you |
| **Delete on-chain bounty** | The contract has **Expired** but its bounty is still open on-chain | Deletes it on-chain and refunds you |

### 3.2 Auditor: stake, claim and prove a vulnerability

1. Switch to **Auditor** and open the **Audit queue** (`/auditor`). It lists
   open, funded contracts.
2. **Stake.** The stake gate locks PoC uploads until you stake the required
   deposit (0.1 ETH on Sepolia; simulated units in demo mode). Click **Stake**
   and confirm.
3. **Claim.** Click **Claim** on a contract. The claim is **exclusive for 10
   minutes** and you can hold **one claim at a time**. A countdown shows the time
   left.

_📷 Screenshot: audit queue with the stake gate and a claimed contract's countdown._

4. **Submit a PoC.** On the claimed contract, pick a finding and upload a
   Foundry test file (`.t.sol`). The test must import the target contract as
   `import "../src/<filename>";` (see the sample PoC). Click **Submit PoC**.
5. The finding moves to **Submitted** while the sandbox runs the test:
   - **Passes** → **Verified**. The challenge window starts.
   - **Fails** → **Rejected**. You can retry on the same claim while it lasts.
6. If nobody disputes before the window closes, the finding becomes **Paid**.
   Your payout appears under **Payout to withdraw** in your profile; click
   **Withdraw** to receive it.

_📷 Screenshot: finding card going Submitted → Verified, then the profile with Payout to withdraw._

**Other auditor actions:**

- **Mark false positive** — flag an AI/Slither finding that is not a real issue.
- **Report a new finding** — report a vulnerability Slither missed. Describe it
  and attach the PoC that proves it (**Submit finding and PoC**). It starts at
  **Submitted** and is verified the same way.
- **Withdraw stake** — take your stake back when it is not locked by an active
  claim or a pending finding.

Your **profile** shows your stake, reputation, claimed contracts (to resume
work) and any payout waiting to be withdrawn.

### 3.3 Developer: dispute a verified finding

If you believe a Verified finding is wrong, open the contract, enter a reason on
that finding and click **Submit dispute** **before the challenge window ends**
(30 s in demo mode, 60 s on the local stack, as configured on Sepolia). The
finding moves to **Disputed** and the payout is held.

_📷 Screenshot: verified finding with the dispute form and remaining challenge time._

### 3.4 Arbiter: resolve a dispute

1. Switch to **Arbiter** and open **Disputes** (`/arbiter`). On Sepolia, only the
   arbiter account set at deployment can rule; anyone else sees "Only the
   arbiter can rule on disputes."
2. Open a pending dispute. Read the developer's reason next to the original
   finding, the PoC and the sandbox result.
3. Rule:
   - **Rule for auditor** → the finding is **Paid** and the auditor can withdraw.
   - **Rule against auditor** → the finding is **Rejected** and **half the
     auditor's stake is slashed**.

_📷 Screenshot: dispute card with the developer's reason, PoC, sandbox log and the two ruling buttons._

### 3.5 Transactions and confirmations

On a real chain, actions like fund, stake, dispute, rule, cancel, refund and
withdraw are transactions. After one confirms, the header shows **Transaction
confirmed**, with a link to the block explorer on Sepolia. Verdicts and payouts
are sent by the platform's operator account, so they have no link.

---

## 4. FAQ / Troubleshooting

### General

**Is any of this real money?**
No. Demo mode simulates everything. The local stack uses Anvil test accounts.
The hosted site runs on the Sepolia testnet; use test ETH only.

**Does the AI decide whether I get paid?**
No. AI explanations are advisory. Only a PoC that passes in the sandbox
verifies a finding, and only the challenge window or the arbiter decides the
payout.

**Why did my demo data disappear?**
Demo mode keeps everything in memory in the browser. A full page reload resets
it. Navigate with the sidebar instead of reloading.

**Why does the hosted site ask me to sign a message?**
That is Sign-In with Ethereum. It proves you own the account and costs no gas.
Sessions last 8 hours.

### Developers

**"Only .sol files are accepted." / "File is too large - the limit is 100 KB."**
Upload a single Solidity file under 100 KB. Multi-file projects are not
supported yet; flatten the contract first.

**"Choose a deadline in the future."**
The deadline must be later than now (in your local time zone).

**The Fund bounty button is disabled.**
"Funding opens once the analysis finishes." If the page shows **Analysis
failed**, the contract probably does not compile; fix it and submit again.

**Reclaim bounty is greyed out.**
It is "Only available after the deadline passes".

### Auditors

**I can't upload a PoC.**
You must have staked the required deposit *and* hold an active claim on that
contract. Claims expire after 10 minutes.

**My PoC was Rejected but I think it is correct.**
Check that it is a Foundry test (`.t.sol`) that imports the target as
`../src/<filename>` and that the test passes locally with `forge test`. After a
failed PoC your stake stays locked until the claim lapses, so you can retry on
the same claim.

**I can't withdraw my stake.**
Stake is locked while you hold a claim or have a finding pending verification
or in dispute. It unlocks when those resolve or the claim expires.

### Wallet and network (hosted site)

**"Wrong network"**
MetaMask is on another chain. Switch it to Sepolia (the app offers to do this
when you connect).

**I switched MetaMask accounts and got signed out.**
That is expected: your identity is the connected account. Click **Connect
wallet** again to sign in as the new account.

**A transaction failed with a revert reason.**
The app simulates each transaction first and shows the contract's reason
without sending it (for example, staking too little or claiming a contract that
is already claimed). Nothing was spent.

**A step failed after the transaction went through.**
For example, the API was briefly unreachable. Repeat the step: if it already
happened on-chain, the app skips straight to the API call.

### Local stack

**`error getting credentials` while building images (WSL).**
Docker Desktop's credential helper is unreachable. The images are public, so
use an empty Docker config:

```sh
mkdir -p /tmp/dc && echo '{}' > /tmp/dc/config.json && DOCKER_CONFIG=/tmp/dc pnpm stack:demo
```

**AI explanations just repeat Slither's text.**
No LLM is configured. Add `LLM_ENDPOINT`, `LLM_MODEL` and `LLM_API_KEY` to
`workers/analysis/.env` and restart the stack.

**Running the demo from a second checkout broke the first one.**
Local stacks share the Compose project name `bbm`. Use `-p <name>` for parallel
stacks.

### Known limitations (current draft)

- Logging out clears the session cookie but cannot revoke a copied cookie
  before it expires (8 hours).
- Only single-file contracts are supported.
- Contract-level stake checks are enforced by the API, not yet by the
  `AuditorStaking` contract.

---

_Further reading: [README](../README.md) (setup and stack details),
[web app](web.md) (wallet modes), [API](api.md), [contracts overview](contracts/overview.md),
[Sepolia runbook](contracts/sepolia.md)._
