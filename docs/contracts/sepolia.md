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
forge script script/Deploy.s.sol --rpc-url "$SEPOLIA_RPC_URL"                  # dry run, sends nothing
forge script script/Deploy.s.sol --rpc-url "$SEPOLIA_RPC_URL" --broadcast --slow
cat deployments/11155111.json
```

`--rpc-url` is required even with `ETH_RPC_URL` set; without it forge
simulates in memory. Trust `deployments/11155111.json` only after the
broadcast succeeds. Besides the addresses it records `arbiter`,
`challengeWindow` and `deployBlock`, where the API's event indexer starts.

Check the wiring:

```sh
cast call "$(jq -r .bountyEscrow deployments/11155111.json)" "disputeResolution()(address)" \
  --rpc-url "$SEPOLIA_RPC_URL"
```

and look the three addresses up on <https://sepolia.etherscan.io>.

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
pnpm --filter @bbm/api dev
```

- The arbiter comes from the deployments file (`arbiter`). Without the file,
  set `AUDITOR_STAKING_ADDRESS`, `BOUNTY_ESCROW_ADDRESS`,
  `DISPUTE_RESOLUTION_ADDRESS` and `ARBITER_ADDRESS` instead.
- `INDEXER_START_BLOCK` overrides the file's `deployBlock`. Without either,
  the indexer would scan Sepolia from block 0.
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

The bbm Helm chart sets `AUTH_ORIGIN=https://<ingress.host>` and
`COOKIE_SECURE=true` for the api. It doesn't wire chain mode yet (`CHAIN_*`,
`OPERATOR_PRIVATE_KEY`, `SESSION_SECRET`). When it does, follow the existing
convention: the RPC URL and operator key stay in Key Vault (set out of band
with `az keyvault secret set`, never in Terraform state or GitHub secrets)
and reach the pod through the CSI SecretProviderClass, like `llm-api-key`.
