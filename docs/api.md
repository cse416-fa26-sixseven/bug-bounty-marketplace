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

Analysis and sandbox jobs go into the Postgres `jobs` table and are processed
by the analysis worker (`workers/analysis`). Stake, disputes and payouts are
not part of this API yet; the web app still mocks them.

Storage is pluggable. Contracts use a `ContractRepository` and findings, PoCs
and jobs a `PipelineRepository` (in-memory, or Postgres via `DATABASE_URL`).
In-memory jobs are never processed; the worker needs Postgres. Source bytes use a `SourceStorage` (in-memory,
or local disk via `SOURCE_STORAGE_DIR`). For a local Postgres, run
`docker compose up -d db` and set
`DATABASE_URL=postgres://bbm:bbm@localhost:5432/bbm`.

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
| `RATE_LIMIT_MAX`            | `600`                                    | Requests per minute to any route without its own limit. `/health` is never limited.                                              |
| `RATE_LIMIT_UPLOAD_MAX`     | `20`                                     | Requests per 10 minutes to each of `POST /api/contracts` and `POST /api/auditor/poc`.                                            |
| `RATE_LIMIT_AUTH_MAX`       | `60`                                     | Requests per minute to each of `POST /api/auth/nonce` and `POST /api/auth/login`.                                                |
| `TRUST_PROXY`               | unset                                    | Comma-separated proxy IPs/CIDRs whose `X-Forwarded-For` is believed. Helm sets the AKS pod CIDR (the Gateway's pods).            |

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
