# @bbm/web

Next.js frontend. API calls go to `/api/*`, which `src/proxy.ts` forwards to
`API_INTERNAL_URL` when it is set (read per request). With
`NEXT_PUBLIC_API_MOCKING=enabled`, MSW mocks the API in the browser instead.

## Pages and mocks

- Routes: `/submit` and `/contracts` (developer), `/auditor` (queue, claim,
  stake gate, PoC), `/arbiter` (disputes), plus `/healthz` for the container
  probe. A header role switcher (zustand, persisted) picks the role; the
  wallet depends on the API's chain (see [Wallets](#wallets)).
- API clients live in `src/lib/api/{developer,auditor,arbiter}.ts` and parse
  responses with the `@bbm/shared` schemas.
- Mocks: `src/mocks/handlers/{developer,auditor,arbiter}.ts`, composed in
  `handlers/index.ts`, backed by an in-memory mock DB split the same way
  (`src/mocks/db/`). `browser.ts` starts the worker in the app; `server.ts`
  runs the same handlers under vitest.
- Without mocking, only `/api/contracts` exists on the real API today, so
  most pages need the mocks.

## Wallets

`GET /api/chain` picks how the browser signs (`chainMode` in
`src/lib/chain/config.ts`). Each mode implements the same `Wallet`
(`src/lib/wallet`) and `TxClient` (`src/lib/chain/calls.ts`), so pages don't
change:

| API chain                         | Mode       | Signer                                                                                   |
| --------------------------------- | ---------- | ---------------------------------------------------------------------------------------- |
| none (or anvil without an RPC URL) | `mock`     | Nothing is signed; mock addresses per role.                                              |
| anvil, chain id 31337             | `local`    | The selected role's anvil key (`src/lib/chain/accounts.ts`), signed in on every role switch. |
| anything else, e.g. Sepolia       | `injected` | The user's EIP-1193 wallet (`window.ethereum`, MetaMask), via viem's `custom` transport. |

**Injected mode** (`src/lib/wallet/injected.ts`). **Connect wallet** runs
`eth_requestAccounts`, switches the wallet to the API's chain
(`wallet_switchEthereumChain`, falling back to `wallet_addEthereumChain` on
4902), then signs in with SIWE. A transaction first makes sure the wallet is
on that chain and the API session is still this account's, signing in again
if not. It is then simulated (a revert shows its reason and nothing is sent),
sent with `eth_sendTransaction` and awaited. Reads use the API's browser RPC
URL when it publishes one. Otherwise they go through the wallet, and fail
with "Wrong network" while it is on another chain. On reload, an account the
wallet already shares counts as connected without a prompt while the session
cookie is still its own; a session for any other account is signed out.
`accountsChanged` (another account, or none) signs out and refetches, so the
new account must connect (sign in) again. `chainChanged` to another chain shows "Wrong
network". A missing wallet, a rejected prompt (4001) or a wallet left on the
wrong chain shows a readable message next to the wallet button.

**Roles with a real wallet.** The role switcher still chooses the workspace
you see (developer, auditor, arbiter). Your identity is always the
connected account: the API acts for the session's address and the contracts
check `msg.sender`. One MetaMask account can fund bounties as a developer
and stake and claim as an auditor. Rulings only work from the arbiter
address the contracts were deployed with; any other account gets "Only the
arbiter can rule on disputes." To act as another person, switch accounts in
MetaMask and connect again. Anvil keys never leave the local chain.

**Block-explorer links.** `src/lib/chain/networks.ts` is the one chain id →
name/explorer map (Sepolia → <https://sepolia.etherscan.io>). After a user
transaction confirms (fund, stake, dispute, rule, cancel, refund, withdraw),
the header shows "Transaction confirmed" with a link to it (`TxNotice`).
`TxLink` renders nothing on chains without an explorer, such as anvil.
Verdicts and payouts are sent by the API's operator, and the API does not
expose their hashes yet, so those statuses have no link.

## Sign-in

Against a real chain the API wants Sign-In with Ethereum (see
[api.md](api.md#sign-in-sign-in-with-ethereum)). `src/lib/api/auth.ts`
(`signIn`, `ensureSignedIn`) takes any `MessageSigner`
(`{ address, signMessage({ message }) }`), so an anvil `PrivateKeyAccount`
and an injected wallet account both work. Before it asks the signer, it
checks that the API's message is SIWE, for that address and for the page's
own domain (`window.location.host`). The anvil keys sign without a prompt, so
this check is the only one they get. Sign-ins run one at a time, because the
session is one cookie. Leave `AUTH_ORIGIN` unset on the API for
`pnpm --filter @bbm/web dev` (the messages then name `localhost:3000`, which
the browser's `Origin` header gives), or set it to the URL you browse.

## Scripts

```sh
NEXT_PUBLIC_API_MOCKING=enabled pnpm dev    # or: pnpm --filter @bbm/web dev
pnpm --filter @bbm/web lint
pnpm --filter @bbm/web typecheck
pnpm --filter @bbm/web test                 # vitest + MSW, no network
pnpm --filter @bbm/web build
```

## Container image

`apps/web/Dockerfile` builds the `output: "standalone"` server. Build it from
the repo root with BuildKit (it uses a cache mount for the pnpm store):

```sh
docker build -f apps/web/Dockerfile -t bbm-web .
docker run -p 3000:3000 -e API_INTERNAL_URL=http://api:3001 bbm-web
```

- `NEXT_PUBLIC_API_MOCKING` is a build arg (default `disabled`). Next inlines
  it into the client bundle, so changing it means rebuilding the image
  (`--build-arg NEXT_PUBLIC_API_MOCKING=enabled`).
- `API_INTERNAL_URL` is a runtime env var, so one image can target any API.
- The server runs as `node` with `node apps/web/server.js` from `/app`, on
  `HOSTNAME=0.0.0.0` and `PORT=3000`. The healthcheck calls `GET /healthz`.
