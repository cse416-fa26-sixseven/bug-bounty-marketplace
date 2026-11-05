# contracts/

Foundry project for the on-chain side of the marketplace: bounty escrow,
auditor staking and dispute resolution. For installing Foundry, fetching
`forge-std`, building, testing and gas snapshots, see
[Foundry setup](foundry-setup.md).

## Layout

| Path                        | Purpose                                                                                                                                                                                                         |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/AuditorStaking.sol`    | Auditor stakes (`REQUIRED_STAKE` = 0.1 ETH), reputation, submission locks, slashing.                                                                                                                            |
| `src/BountyEscrow.sol`      | Holds a developer's ETH bounty per contract. Records submissions and the first verified finding, pays it after the challenge window (pull-based), refunds after the deadline plus refund delay.                 |
| `src/DisputeResolution.sol` | Developer opens a dispute on a verified finding during the challenge window; the arbiter rules within `RULING_WINDOW` (3 days), or the dispute lapses in the auditor's favour. A losing auditor is slashed 50%. |
| `src/Placeholder.sol`       | Original scaffold contract.                                                                                                                                                                                     |
| `script/Deploy.s.sol`       | Deploys and wires the three contracts.                                                                                                                                                                          |
| `test/`                     | Forge tests, one file per contract plus `Deploy.t.sol`.                                                                                                                                                         |
| `deployments/`              | `<chainid>.json` address files written by the deploy script (git-ignored).                                                                                                                                      |
| `.gas-snapshot`             | Committed `forge snapshot` output, checked in CI.                                                                                                                                                               |
| `Dockerfile`                | Foundry toolchain image (anvil by default; also runs the deploy).                                                                                                                                               |

## Roles

- **Operator** – the backend account. Records submissions and verifications,
  pays out, locks auditor submissions, and binds `DisputeResolution` once.
- **Arbiter** – the admin who rules on disputes.
- **Developer / auditor** – end users who fund bounties and stake.

What the operator key can and cannot do, where it is stored, and how a
compromise is contained: [ADR 0005](../adr/0005-operator-key-trust-model.md).

## Wiring order

The contracts reference each other, so they are deployed in this order:

1. `AuditorStaking(operator)`
2. `BountyEscrow(operator, staking, challengeWindow, refundDelay)`
3. `DisputeResolution(arbiter, staking, escrow)`
4. `staking.bindDisputeResolution(dr)` and `escrow.bindDisputeResolution(dr)`

Step 4 is `onlyOperator` and can only happen once (`AlreadyBound`), so the
deploying account must be the operator. Both contracts expose the bound
address as `disputeResolution()` (selector `0xbe9157cf`).

## Deploy script

`script/Deploy.s.sol` (`contract Deploy`) does the steps above. All settings
come from environment variables, all optional:

| Variable                   | Default           | Meaning                                                                                                                            |
| -------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `DEPLOYER_PRIVATE_KEY`     | unset             | Key to broadcast with. Unset (or 0) uses the CLI sender (`--private-key`, `--sender`).                                             |
| `OPERATOR`                 | broadcaster       | Backend operator. Must equal the broadcaster, otherwise the script reverts with `Deploy: OPERATOR must equal the broadcaster ...`. |
| `ARBITER`                  | broadcaster       | Dispute arbiter.                                                                                                                   |
| `CHALLENGE_WINDOW`         | `259200` (3 days) | Seconds after verification before a finding can be paid.                                                                           |
| `REFUND_DELAY`             | `10800` (3 hours) | Seconds after the deadline before the developer can refund.                                                                        |
| `WRITE_DEPLOYMENTS`        | `true`            | Write `deployments/<chainid>.json` on a `--broadcast` run. Dry runs and tests never write.                                         |
| `REQUIRE_DISTINCT_ARBITER` | `false`           | Revert unless `ARBITER` differs from `OPERATOR`. The Sepolia deploy workflow sets it (ADR 0005).                                   |

After a broadcast, `deployments/<chainid>.json` looks like:

```json
{
  "arbiter": "0x...",
  "auditorStaking": "0x...",
  "bountyEscrow": "0x...",
  "chainId": 31337,
  "challengeWindow": 259200,
  "deployBlock": 0,
  "disputeResolution": "0x...",
  "operator": "0x...",
  "refundDelay": 10800
}
```

`deployBlock` is the chain head when the script ran; the deploy transactions
land at or after it. The API starts its event indexer there (see
[Sepolia](sepolia.md)), so it doesn't scan a testnet from block 0.

The file is written while forge executes the script, before the transactions
are sent. If the broadcast itself fails, forge exits non-zero and the file may
hold addresses that were never deployed, so only trust it after a successful
run.

`Deploy.deploy(Config)` contains the deployment logic without the env reading
or file writing, which is what `test/Deploy.t.sol` calls.

## Local deploy against anvil

```sh
cd contracts
anvil                                  # terminal 1, chain id 31337 on :8545

# terminal 2: anvil's account #0 becomes operator and arbiter
forge script script/Deploy.s.sol \
  --rpc-url http://127.0.0.1:8545 --broadcast \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
cat deployments/31337.json

cast call "$(jq -r .bountyEscrow deployments/31337.json)" \
  "disputeResolution()(address)" --rpc-url http://127.0.0.1:8545
```

On a fresh anvil with account #0 the addresses are deterministic:
`auditorStaking` `0x5FbDB2315678afecb367f032d93F642f64180aa3`,
`bountyEscrow` `0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512`,
`disputeResolution` `0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0`.

## Container image

`contracts/Dockerfile` builds from `ghcr.io/foundry-rs/foundry:v1.3.5` with
`contracts/` as the build context (the `forge-std` submodule must be checked
out). It runs `forge build` at build time, so solc 0.8.19 is cached in the
image and nothing needs the network at runtime. It runs as the image's
non-root `foundry` user (uid 1000); `/contracts` and `/contracts/deployments`
are owned by that user.

- Default command: `anvil --host 0.0.0.0 --chain-id 31337`, port 8545, with a
  `cast block-number` healthcheck.
- One-shot deploy: same image, entrypoint overridden to
  `forge script script/Deploy.s.sol --rpc-url http://anvil:8545 --broadcast`,
  with the key in `DEPLOYER_PRIVATE_KEY` and a volume on
  `/contracts/deployments` to collect the JSON.

In the compose stack these are the `anvil` and `contracts-deploy` services:

```sh
pnpm stack:up                  # anvil on :8545
pnpm stack:deploy-contracts    # docker compose run --rm contracts-deploy (anvil account #0)
```

The deploy writes to the `deployments` volume; in CI
(`docker-compose.ci.yml`) it is bind-mounted to `.ci/deployments/`, where the
chain integration tests read `31337.json`.

## CI and testnet deploy

- `ci.yml` `contracts` job: `forge build`, `forge test -vvv`,
  `forge snapshot --check`, a `forge script script/Deploy.s.sol` dry run, and
  Slither (advisory, `fail-on: none`).
- `contracts-deploy.yml` (manual dispatch) deploys to **Sepolia** for one
  environment, `staging` or `prod`, in that GitHub Environment (prod needs a
  reviewer). Each environment has its own contracts and operator key
  ([ADR 0005](../adr/0005-operator-key-trust-model.md)). Inputs: `env`,
  `arbiter` (required; must differ from the operator), `broadcast` and
  `replace_existing` (refuses to overwrite an existing deployment without
  it). `broadcast=false` (the default) simulates against live Sepolia state
  and sends nothing. The RPC URL and operator key are read over OIDC from the
  env's chain Key Vault (`chain-rpc-url`, `operator-private-key`), never from GitHub
  secrets; see [Azure bootstrap](../devops/azure-bootstrap.md). After a
  broadcast the deployments file is stored in the same vault as
  `chain-deployment`, which the API mounts. The run summary lists the
  addresses, and `broadcast/` + `deployments/` are uploaded as an artifact.
