# Sepolia runbook

How to deploy the contracts to Sepolia (chain id `11155111`) and run the API
and the web app against them. Nothing here is automated end to end: a human
supplies the RPC URL and funded keys, and every broadcast is deliberate.

## What you need

| Thing                    | Notes                                                                                                                                           |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Sepolia RPC URL          | An Alchemy or Infura URL. It usually carries an API key, so keep it secret (`SEPOLIA_RPC_URL` below; `sepolia-rpc-url` in the shared Key Vault). |
| Deployer / operator key  | One funded Sepolia account. `Deploy.s.sol` requires the operator to be the broadcaster, so the API's `OPERATOR_PRIVATE_KEY` is this same key. It pays gas for the deploy and later for every verdict and payout, so give it ~0.2 Sepolia ETH. Shared Key Vault: `sepolia-deployer-key`. |
| Arbiter address          | A separate account that rules on disputes, e.g. a MetaMask account. Only its address is needed at deploy time (`ARBITER`). |
| Test users               | MetaMask accounts for a developer and an auditor, each with Sepolia ETH from a faucet. The auditor needs the required stake (0.1 ETH) plus gas. |

Never commit a key or a keyed RPC URL, and never pass a key on the command
line (it lands in shell history and `ps`): export it from a file or a vault.

## 1. Deploy the contracts

**From CI (preferred).** `contracts-deploy.yml` (manual dispatch, `contracts-sepolia`
environment, one reviewer) reads `sepolia-rpc-url` and `sepolia-deployer-key`
from the shared Key Vault over OIDC. Set them once as in
[Azure bootstrap](../devops/azure-bootstrap.md) (`az keyvault secret set`, `--file`
for the key), run the workflow with `broadcast=false` to dry-run against live
Sepolia, then with `broadcast=true`. The run's artifact holds
`deployments/11155111.json`. To set `ARBITER` or shorter windows from CI, add
them to that step's `env` first; by default the deployer is also the arbiter
and the challenge window is 3 days.

**By hand.** With Foundry v1.3.5:

```sh
cd contracts
export SEPOLIA_RPC_URL=...                          # from your provider; keep it out of git
export DEPLOYER_PRIVATE_KEY="$(cat ~/secrets/sepolia-deployer.key)"
export ARBITER=0x...                                # the arbiter's address
export CHALLENGE_WINDOW=600 REFUND_DELAY=600        # 10 minutes for a demo (defaults: 3 days, 3 hours)

test "$(cast chain-id --rpc-url "$SEPOLIA_RPC_URL")" = 11155111
# --gas-estimate-multiplier 800: forge 1.3.5 underestimates creation gas ~7x on current Sepolia
forge script script/Deploy.s.sol --rpc-url "$SEPOLIA_RPC_URL" --gas-estimate-multiplier 800                      # dry run, sends nothing
forge script script/Deploy.s.sol --rpc-url "$SEPOLIA_RPC_URL" --gas-estimate-multiplier 800 --broadcast --slow
cat deployments/11155111.json
```

`--rpc-url` is required even with `ETH_RPC_URL` set; without it forge
simulates in memory.

`--gas-estimate-multiplier 800` is required too. Sepolia now runs a newer
fork (200M block gas limit, repriced contract-creation and state costs) that
Foundry 1.3.5's local simulation doesn't model, so it sends creations with
about a seventh of the gas they need (e.g. 855,540 for `AuditorStaking`
where the node's `eth_estimateGas` says ~4.57M) and they fail on-chain with
`status 0` and `gasUsed == gasLimit`. 400 is still too low; 800 works and
stays under the ~16.7M per-transaction cap. Only gas actually used is
charged, so the larger limit costs nothing extra.

Load-balanced public RPCs (e.g. publicnode) intermittently fail forge with
`block not found`, because consecutive calls hit different backends. Just
re-run the command.

The script writes `deployments/11155111.json` before the transactions are
sent, and a failed creation is still mined and burns the deployer's nonce,
so after a failure the file names addresses that hold no code (and the next
attempt deploys to different ones). Trust the file only when forge ends with
`ONCHAIN EXECUTION COMPLETE & SUCCESSFUL`; otherwise fix the cause and
deploy again. Besides the addresses the file records
`arbiter`, `challengeWindow` and `deployBlock`, where the API's event
indexer starts.

Check the wiring:

```sh
cast call "$(jq -r .bountyEscrow deployments/11155111.json)" "disputeResolution()(address)" \
  --rpc-url "$SEPOLIA_RPC_URL"
```

and look the three addresses up on <https://sepolia.etherscan.io>.

## Current deployment

Deployed by hand on 2026-11-05 with Foundry 1.3.5 (`CHALLENGE_WINDOW=600`,
`REFUND_DELAY=600`).

| Contract / role     | Address                                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `AuditorStaking`    | [`0xd9af438168B9179e22FC1EaCCca1119B2f9d2Bc7`](https://sepolia.etherscan.io/address/0xd9af438168B9179e22FC1EaCCca1119B2f9d2Bc7) |
| `BountyEscrow`      | [`0x8BB9117a886a5364C6d6c05e2E8ffbD37A5dDf43`](https://sepolia.etherscan.io/address/0x8BB9117a886a5364C6d6c05e2E8ffbD37A5dDf43) |
| `DisputeResolution` | [`0x6004cedfB4c7cd39dCEb9e2B71bfD645Da79AA11`](https://sepolia.etherscan.io/address/0x6004cedfB4c7cd39dCEb9e2B71bfD645Da79AA11) |
| Operator / deployer | [`0xdea2B702BaF885F2388F02F285a8b5306c59c011`](https://sepolia.etherscan.io/address/0xdea2B702BaF885F2388F02F285a8b5306c59c011) |
| Arbiter             | [`0xE506507e9d6016EE856407061560322AF3F048Eb`](https://sepolia.etherscan.io/address/0xE506507e9d6016EE856407061560322AF3F048Eb) |

| Setting           | Value      |
| ----------------- | ---------- |
| `deployBlock`     | `12066691` |
| `challengeWindow` | 600 s      |
| `refundDelay`     | 600 s      |

`deployments/*.json` is not committed, so this table is the shared record.
To run the API against this deployment without the file, set
`AUDITOR_STAKING_ADDRESS`, `BOUNTY_ESCROW_ADDRESS`,
`DISPUTE_RESOLUTION_ADDRESS`, `ARBITER_ADDRESS`, `CHALLENGE_WINDOW_SECONDS=600`
and `INDEXER_START_BLOCK=12066691` from it. The operator key stays with
whoever deployed and is never committed.

## 2. Run the API against Sepolia

Chain actions (verdicts, payouts, the indexer) need Postgres, so start it
first: `docker compose up -d db`. Then:

```sh
export DATABASE_URL=postgres://bbm:bbm@localhost:5432/bbm
export CHAIN_RPC_URL="$SEPOLIA_RPC_URL"             # the API's own RPC; never sent to browsers
export CHAIN_ID=11155111
export CHAIN_DEPLOYMENTS_FILE="$PWD/contracts/deployments/11155111.json"
export OPERATOR_PRIVATE_KEY="$DEPLOYER_PRIVATE_KEY"  # must be the deployer (the operator)
export SESSION_SECRET="$(openssl rand -hex 32)"
export AUTH_ORIGIN=http://localhost:3000            # the URL you browse; https://... in a deployment
export CLAIM_LOCK_ENABLED=true
export INDEXER_CONFIRMATIONS=3                       # see below; public RPCs need a few
pnpm --filter @bbm/api dev
```

- The arbiter comes from the deployments file (`arbiter`). Without the file,
  set `AUDITOR_STAKING_ADDRESS`, `BOUNTY_ESCROW_ADDRESS`,
  `DISPUTE_RESOLUTION_ADDRESS` and `ARBITER_ADDRESS` instead.
- `INDEXER_START_BLOCK` overrides the file's `deployBlock`. Without either,
  the indexer would scan Sepolia from block 0.
- `INDEXER_CONFIRMATIONS` (default 0) keeps the indexer that many blocks
  behind the head. Use 3 on Sepolia, and always with a load-balanced public
  RPC: it can report the head from one backend and serve `eth_getLogs` from
  another a block behind, which fails every indexer run with
  `block range extends beyond current head block`. Status changes then show
  up about 3 blocks (~36 s) after the transaction.
- `PUBLIC_CHAIN_RPC_URL` is optional. Leave it unset unless you have a
  keyless public endpoint: `GET /api/chain` publishes it, and without it the
  browser reads through the user's wallet.
- `COOKIE_SECURE` defaults to on when `AUTH_ORIGIN` is https.
- Run the analysis worker with `CHAIN_ENABLED=true` as in
  `docker-compose.chain.yml`, so the API applies sandbox verdicts on-chain.

`curl -s localhost:3001/api/chain` should report `"chainId": 11155111`.

## 3. Run the web app

```sh
NEXT_PUBLIC_API_MOCKING=enabled NEXT_PUBLIC_LIVE_PIPELINE=enabled NEXT_PUBLIC_LIVE_CHAIN=enabled \
  API_INTERNAL_URL=http://localhost:3001 pnpm --filter @bbm/web dev
```

(or a `NEXT_PUBLIC_API_MOCKING=disabled` build). Because the chain is not
anvil, the app switches to the injected wallet ([web.md](../web.md#wallets)):
open <http://localhost:3000>, click **Connect wallet**, approve the account,
let MetaMask switch to Sepolia, and sign the Sign-In with Ethereum message.
After each transaction a notice links it on Sepolia Etherscan.

## Deployed environments

The bbm Helm chart runs the api in chain mode with `chain.enabled: true`
(`values.yaml` documents every `chain.*` value). Prod turns it on in
`values-prod.yaml` with the deployment above; test and staging stay off,
because the operator key signs verdicts and payouts and two APIs sharing it
would race each other's nonces.

With `chain.enabled` the chart:

- sets the api's `CHAIN_*`, contract addresses, `ARBITER_ADDRESS`,
  `CHALLENGE_WINDOW_SECONDS`, `INDEXER_*`, `PAYOUT_KEEPER_INTERVAL_SECONDS` and
  `CLAIM_LOCK_ENABLED`, plus `AUTH_ORIGIN=https://<ingress.host>` and
  `COOKIE_SECURE=true` (it fails to render without `ingress.host`);
- reads `OPERATOR_PRIVATE_KEY` and `SESSION_SECRET` from the `bbm-secrets` keys
  `operator-private-key` and `session-secret`, which the CSI driver syncs from
  the env's Key Vault secrets `chain-operator-key` and `session-secret`;
- sets `CHAIN_ENABLED=true` on the analysis worker, so the api applies
  sandbox verdicts on-chain.

`chain.rpcUrl` is a plain value, so it must be keyless (publicnode). Set the two
secrets out of band before deploying, never in Terraform or GitHub:

```sh
umask 077
# The operator is the deployer: 0x + 64 hex, from the shared vault.
az keyvault secret show --vault-name <shared vault> --name sepolia-deployer-key --query value -o tsv | tr -d '\n' > op
openssl rand -hex 32 | tr -d '\n' > ss
az keyvault secret set --vault-name <env vault> --name chain-operator-key --file op --encoding utf-8
az keyvault secret set --vault-name <env vault> --name session-secret --file ss --encoding utf-8
rm op ss
```

If either secret is missing, the CSI mount fails and the api pod never
starts, so set them before the first deploy with `chain.enabled` (and again
after rebuilding the env's vault). The api reads them once at start: after
rotating one, run `kubectl -n bbm rollout restart deploy/bbm-api`.

Stop any other API using the same operator key (for example a local Sepolia
stack) while prod runs, and avoid running `contracts-deploy.yml` with
`broadcast=true` at the same time: both sign with that key and would race on
nonces.
