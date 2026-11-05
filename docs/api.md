# @bbm/api

Fastify app. Exposes `GET /health`, contract upload, and the analysis
pipeline routes ([design](superpowers/specs/2026-10-19-analysis-pipeline-design.md)).

| Route                                                  | Behaviour                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /api/contracts`                                  | Multipart `file` (`.sol`, at most 100 KB) plus `developerAddress`, `bountyAmount`, `currency` (default `ETH`), `deadline`. Stores the source, records the contract and bounty, and queues an analysis job. `201` with the `Contract`; `400` with `issues`; `413` if too large. |
| `GET /api/contracts?developerAddress=`                 | Contracts, newest first, optionally one developer's. `400` for a malformed address.                                                                                                                                                                                            |
| `GET /api/contracts/:id`                               | The `Contract`, or `404`. A claim past its expiry reads back as `Open`.                                                                                                                                                                                                        |
| `GET /api/contracts/:id/findings`                      | `Finding[]`, most severe first. `404` for an unknown contract.                                                                                                                                                                                                                 |
| `GET /api/contracts/:id/analysis`                      | `AnalysisStatus` of the latest analysis job (`Queued`, `Running`, `Done`, `Failed` with `error`). `404` if none.                                                                                                                                                               |
| `GET /api/findings/:id/raw`                            | The finding's raw Slither detector JSON (each finding's `rawOutputReference` points here).                                                                                                                                                                                     |
| `GET /api/auditor/queue?sort=deadline\|bounty\|newest` | Contracts open to claim, with `bounty {amount, currency}`. `400` for an unknown sort.                                                                                                                                                                                          |
| `POST /api/auditor/claim`                              | JSON `{contractId, auditorId}`. Exclusive claim for `CLAIM_WINDOW_SECONDS`. `409` if already claimed, `404` if unknown.                                                                                                                                                        |
| `POST /api/auditor/poc`                                | Multipart `findingId`, `auditorId`, `file` (`.t.sol`, at most 100 KB). The auditor must hold the active claim (`403`) and the finding must be `Flagged` (`409`). Marks it `Submitted` and queues a sandbox job. `201` with the `PoCSubmission`.                                |
| `POST /api/auditor/findings`                           | Multipart `contractId`, `auditorId`, `title` (≤ 120 chars), `severity`, `description` (plain text, ≤ 4000 chars), `file` (`.t.sol`, at most 100 KB): reports a finding Slither missed, with its PoC. Same claim (`403`) and stake (`403`) checks as a PoC upload; `400` with `issues`, `404` for an unknown contract, `413` if too large. Creates the finding (`source: "auditor"`, `slitherDetector: "auditor-reported"`, the description in `llmExplanation`) already `Submitted`, with its PoC and sandbox job in one transaction. `201` with `{finding, poc}`. |
| `PUT /api/findings/:id/note`                           | JSON `{note, developerId}`: the contract's developer sets their note on a finding (plain text, trimmed, ≤ 2000 chars; `""` or `null` clears it). With a chain configured the writer is the signed-in wallet (`401` without a session) and `developerId` is optional. `403` for anyone but the contract's developer, `400` with `issues`, `404` for an unknown finding. `200` with the updated `Finding`. |

Every `Finding` carries `source` (`slither` or `auditor`), `title` and
`reportedByAuditorId` (both `null` for Slither findings). Auditor-reported
findings reuse the existing non-null fields rather than making them nullable,
so the worker, the chain actions and every view keep working unchanged:
`slitherDetector` is `auditor-reported`, `llmExplanation` holds the auditor's
description (the views label it as the auditor's, not as AI output), and
`GET /api/findings/:id/raw` returns the report as submitted. On-chain the
finding is keyed by `onchainId(findingId)` like any other, so
`recordSubmission`/`recordVerification` need no change. The reporting auditor
chooses an auditor-reported finding's `severity`; like a Slither finding's,
it is advisory (ordering and display only). Payout never depends on it: the
first verified PoC is paid the bounty, whatever its severity.

Developer notes (R16) are `developerNote` / `developerNoteUpdatedAt` on the
`Finding` (both `null` when there is none). Only the contract's developer
writes a note; it is returned with the finding wherever the finding is
returned, so the claiming auditor's and the arbiter's views show it
read-only. Finding reads are not access-controlled today, so a note is
exactly as visible as the finding it annotates.

Analysis and sandbox jobs go into the Postgres `jobs` table and are processed
by the analysis worker (`workers/analysis`). Stake, disputes and payouts are
not part of this API yet; the web app still mocks them.

Storage is pluggable. Contracts use a `ContractRepository` and findings, PoCs
and jobs a `PipelineRepository` (in-memory, or Postgres via `DATABASE_URL`).
In-memory jobs are never processed; the worker needs Postgres. Source bytes use a `SourceStorage` (in-memory,
or local disk via `SOURCE_STORAGE_DIR`). For a local Postgres, run
`docker compose up -d db` and set
`DATABASE_URL=postgres://bbm:bbm@localhost:5432/bbm`.

## Sign-in (Sign-In with Ethereum)

With `SESSION_SECRET` set (required once `CHAIN_RPC_URL` is), user routes act
for the signed-in wallet. Sign-in follows
[EIP-4361](https://eips.ethereum.org/EIPS/eip-4361), built with `viem/siwe`:

| Route                   | Behaviour                                                                                                                                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/auth/nonce`  | JSON `{address}`. `{nonce, message}`: a SIWE message naming the web app's domain and URI, the address, the API's `CHAIN_ID`, a single-use nonce, `Issued At` and an `Expiration Time` 5 minutes on. `400` for a bad address. |
| `POST /api/auth/login`  | JSON `{message, signature}` (optional `address`, which must match). Sets the `bbm_session` cookie and returns `{address}`. `401` when the nonce is unknown, spent or expired, or the domain, URI, chain or address differs.     |
| `GET /api/auth/me`      | `{address}` of the session, or `401`.                                                                                                                                                                                           |
| `POST /api/auth/logout` | Clears the cookie.                                                                                                                                                                                                              |

**Which domain a message names.** With `AUTH_ORIGIN` set (e.g.
`https://bountyguard.example`), every message names that origin, whatever the
request says; set it in every deployment (Helm sets it to
`https://<ingress.host>`). Without it the origin comes from the request: the
browser's `Origin` header first (browsers send it on every POST, and the web
app's `/api` proxy passes it through unchanged), then `Host`. The Next.js
proxy rewrites `Host` to the API's and puts the page's in `X-Forwarded-Host`,
which is believed only from a `TRUST_PROXY` proxy (Fastify's `request.host`).
That fallback is for local development: a client can claim any origin, so
only a fixed `AUTH_ORIGIN` lets the server refuse messages for another site.
With `AUTH_ORIGIN` set, a nonce or login request whose `Origin` header names
another site is refused (scripts that send no `Origin` get the configured
one). Without it, login checks that the request comes from the domain the
message names. A nonce is spent before the signature check is awaited, so two
concurrent logins with one signature cannot both succeed.

Nonces live in memory for 5 minutes (at most 5 open per address), so sign-in
needs a single API replica. The session is an HMAC-signed cookie (address and
expiry, 8 hours), `HttpOnly; SameSite=Lax`, plus `Secure` when `COOKIE_SECURE`
is on.

## Environment variables

| Variable                    | Default                                  | Effect                                                                                                                           |
| --------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                      | `3001`                                   | HTTP port (binds `0.0.0.0`).                                                                                                     |
| `DATABASE_URL`              | unset                                    | Unset: contracts are held in memory. Set: Postgres-backed repository.                                                            |
| `MIGRATE_ON_BOOT`           | `true`                                   | With `DATABASE_URL`, apply migrations at startup. `false`/`0`/`no`/`off` disables it (run `migrate` as a separate step instead). |
| `PG_POOL_MAX`               | `5`                                      | Maximum connections in the Postgres pool.                                                                                        |
| `MIGRATION_LOCK_TIMEOUT_MS` | `60000`                                  | How long a migration run waits for the advisory lock (via `lock_timeout`) before failing.                                        |
| `MIGRATIONS_DIR`            | `migrations/` next to the running module | Directory of `*.sql` migrations. Resolves to `src/db/migrations` under `dev` and `dist/migrations` in the build.                 |
| `SOURCE_STORAGE_DIR`        | unset                                    | Unset: uploaded `.sol` and `.t.sol` bytes are held in memory. Set: written under this directory (shared with the worker).        |
| `CLAIM_WINDOW_SECONDS`      | `600`                                    | How long an auditor's exclusive claim on a contract lasts.                                                                       |
| `RATE_LIMIT_ENABLED`        | `true`                                   | Per-client-IP rate limits. `false` turns them off (the compose stack and ephemeral test namespaces do).                          |
| `RATE_LIMIT_MAX`            | `3000`                                   | Requests per minute to any route without its own limit. `/health` is never limited.                                              |
| `RATE_LIMIT_UPLOAD_MAX`     | `20`                                     | Requests per 10 minutes to each of `POST /api/contracts` and `POST /api/auditor/poc`.                                            |
| `RATE_LIMIT_AUTH_MAX`       | `60`                                     | Requests per minute to each of `POST /api/auth/nonce` and `POST /api/auth/login`.                                                |
| `TRUST_PROXY`               | unset                                    | Comma-separated proxy IPs/CIDRs whose `X-Forwarded-For` is believed. Helm sets the AKS pod CIDR (the Gateway's pods).            |
| `SESSION_SECRET`            | unset                                    | HMAC key (16+ characters) for session cookies. Enables sign-in; required with `CHAIN_RPC_URL`.                                   |
| `AUTH_ORIGIN`               | unset                                    | The web app's public origin, which every SIWE message names. Unset: taken from each request (dev only: warns; with a chain and `NODE_ENV=production` the API refuses to start). The demo stack sets `http://localhost:3000`. |
| `COOKIE_SECURE`             | `true` if `AUTH_ORIGIN` is `https`       | Marks the session cookie `Secure`. Leave it off for the plain-http local demo.                                                   |
| `INDEXER_START_BLOCK`       | the deployments file's `deployBlock`     | With `CHAIN_RPC_URL`, the first block the event indexer reads when it has no checkpoint. Unset without a `deployBlock`: block 0. |
| `INDEXER_CONFIRMATIONS`     | `0`                                      | With `CHAIN_RPC_URL`, how many blocks behind the head the event indexer stops. Use `3` on Sepolia and with load-balanced public RPCs, which can serve `eth_getLogs` from a backend a block behind the head they reported. A malformed value fails startup. |

Over a limit the API answers `429` with `Retry-After` and
`{ "statusCode": 429, "error": "Too many requests; try again in N seconds" }`.
Counters are kept per process, so with several replicas a client can get up
to `replicas ×` each limit. Without `TRUST_PROXY` the client is the socket
peer, so behind a proxy every client shares one limit (the API warns at boot).

Migrations are applied in filename order while holding a Postgres advisory
lock, so several replicas booting at once apply them one at a time. If a run
fails, its connection is discarded so the lock is always freed.

## Scripts

- `pnpm --filter @bbm/api dev` — run from source with hot reload (tsx)
- `pnpm --filter @bbm/api typecheck`
- `pnpm --filter @bbm/api test`
- `pnpm --filter @bbm/api build` — typecheck, then bundle `src/index.ts` and
  `src/db/migrate-cli.ts` into `dist/` with esbuild (`build.mjs`) and copy the
  SQL migrations to `dist/migrations/`. `@bbm/shared` and its dependencies
  are inlined; `fastify`, `@fastify/multipart` and `pg` stay external, so a
  runtime image needs `dist/` plus the API's production `node_modules`.
- `pnpm --filter @bbm/api start` — `node dist/index.js`; SIGTERM/SIGINT close
  the server and the pool, then exit 0. A second signal, or a close that takes
  longer than 10 s, forces exit 1.
- `pnpm --filter @bbm/api migrate` — `node dist/migrate-cli.js`; applies the
  migrations against `DATABASE_URL` (required) and exits.

Postgres-backed repository tests run only when `DATABASE_URL` is set; they are
skipped otherwise. CI's `api` job sets it (Postgres service container), then
boots the built `dist/index.js` and waits for `/health`. End-to-end checks of
the API through the web proxy live in [`tests/`](../tests/README.md).

## Container image

`apps/api/Dockerfile` builds a production image. Build it from the repo root
with BuildKit (it uses a cache mount for the pnpm store):

```sh
docker build -f apps/api/Dockerfile -t bbm-api .
docker run -p 3001:3001 -e DATABASE_URL=postgres://... bbm-api
docker run --rm -e DATABASE_URL=postgres://... bbm-api node dist/migrate-cli.js
```

The runtime stage holds only `dist/` plus the production `node_modules` from
`pnpm deploy --prod`, runs as `node`, and listens on `PORT` (default `3001`).
`SOURCE_STORAGE_DIR` defaults to `/data/sources`, the only writable directory;
mount a volume there to keep uploaded sources. The healthcheck calls
`GET /health`.
