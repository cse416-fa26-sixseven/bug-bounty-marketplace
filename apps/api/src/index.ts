import { Pool } from "pg";
import { buildApp } from "./app.js";
import {
  createAuditorStakingFromConfig,
  createBountyEscrowFromConfig,
  createDisputeResolutionFromConfig,
} from "./chain/clients.js";
import { PgDisputeRepository } from "./disputes/pg-repository.js";
import { claimLockEnabled, loadChainConfig } from "./chain/config.js";
import { createChainActions, type ChainActions } from "./chain/actions.js";
import { PgChainActionStore } from "./chain/pg-action-store.js";
import { startPayoutKeeper, type PayoutKeeper } from "./chain/payout-keeper.js";
import { runVerdictsOnce, startVerdictLoop } from "./chain/verdict-loop.js";
import { startEventIndexer, type EventIndexerHandle } from "./indexer/indexer.js";
import { PgIndexerLock, PgIndexerRepository, listFindingIds } from "./indexer/pg-repository.js";
import { claimLockReleaser } from "./indexer/claim-lock-release.js";
import {
  composeStatusHooks,
  disputeSettler,
  rejectedClaimEnder,
} from "./indexer/dispute-settler.js";
import { PgContractRepository } from "./contracts/pg-repository.js";
import { PgPipelineRepository } from "./pipeline/pg-repository.js";
import { LocalSourceStorage, MemorySourceStorage } from "./contracts/storage.js";
import { runMigrations } from "./db/migrate.js";
import { parseBoolEnv, parseIntEnv } from "./env.js";
import { loadRateLimitConfig, parseTrustProxy } from "./http/rate-limit.js";

// DATABASE_URL selects Postgres. Without it the API keeps contracts in memory,
// which is fine for local UI work and tests. MIGRATE_ON_BOOT (default true)
// applies migrations at startup; PG_POOL_MAX caps the pool (default 5).
// SOURCE_STORAGE_DIR selects local-disk source storage; without it sources
// are held in memory.
const databaseUrl = process.env.DATABASE_URL;
const storageDir = process.env.SOURCE_STORAGE_DIR;
const migrateOnBoot = parseBoolEnv(process.env.MIGRATE_ON_BOOT, true);
const pool = databaseUrl
  ? new Pool({ connectionString: databaseUrl, max: parseIntEnv(process.env.PG_POOL_MAX, 5) })
  : undefined;

// CHAIN_RPC_URL selects the chain. Without it the PoC stake gate is skipped
// (and logged on every upload) and no chain action runs. Chain actions (claim
// locks, verdicts, payouts) keep their bookkeeping in Postgres, so without
// DATABASE_URL they are disabled. The on-chain claim lock is off unless
// CLAIM_LOCK_ENABLED=true, because a lock with no unlock can strand an
// auditor's stake; the PoC stake gate reads stake regardless of that flag.
const chainConfig = loadChainConfig(process.env);
if (!chainConfig) {
  console.warn("@bbm/api CHAIN_RPC_URL is unset: PoC uploads skip the auditor stake check");
}
if (chainConfig && !pool) {
  console.warn("@bbm/api CHAIN_RPC_URL is set but DATABASE_URL is not; chain actions are disabled");
}
// The port is only constructed when a chain is configured; no RPC call is made here.
// With a chain, user routes act for the signed-in wallet, so sign-in needs a
// session secret.
const sessionSecret = process.env.SESSION_SECRET || undefined;
if (chainConfig && (!sessionSecret || sessionSecret.length < 16)) {
  throw new Error(
    "CHAIN_RPC_URL is set but SESSION_SECRET is missing or shorter than 16 characters (needed for wallet sign-in)",
  );
}
const stakingPort = chainConfig ? createAuditorStakingFromConfig(chainConfig) : null;
const lockEnabled = claimLockEnabled(process.env);
const bountyEscrowPort = chainConfig ? createBountyEscrowFromConfig(chainConfig) : undefined;
const actionStore =
  chainConfig && pool
    ? new PgChainActionStore(pool, { challengeWindowSeconds: chainConfig.challengeWindowSeconds })
    : undefined;
const chainActions: ChainActions | undefined =
  chainConfig && pool && actionStore
    ? createChainActions({
        store: actionStore,
        bountyEscrow: bountyEscrowPort,
        auditorStaking: lockEnabled && stakingPort ? stakingPort : undefined,
        claimLockEnabled: lockEnabled,
      })
    : undefined;

const contractRepository = pool ? new PgContractRepository(pool) : undefined;
const pipelineRepository = pool ? new PgPipelineRepository(pool) : undefined;
const disputeRepository = pool ? new PgDisputeRepository(pool) : undefined;

// Per-client-IP rate limits (RATE_LIMIT_*), on by default. TRUST_PROXY lists
// the proxies (CIDRs) whose X-Forwarded-For is believed; behind the k8s
// Gateway it is the pod CIDR. Without it every request seems to come from the
// proxy, so all clients share one limit.
const rateLimit = loadRateLimitConfig(process.env);
const trustProxy = parseTrustProxy(process.env.TRUST_PROXY);
if (rateLimit.enabled && !trustProxy) {
  console.warn("@bbm/api TRUST_PROXY is unset: rate limits key on the socket peer, so clients behind one proxy share a limit");
}

const app = buildApp({
  rateLimit,
  trustProxy,
  repository: contractRepository,
  pipeline: pipelineRepository,
  storage: storageDir ? new LocalSourceStorage(storageDir) : new MemorySourceStorage(),
  // The PoC stake gate reads stake regardless of CLAIM_LOCK_ENABLED.
  stakeReader: stakingPort,
  chainActions,
  chainConfig,
  sessionSecret,
  bountyEscrow: bountyEscrowPort,
  disputeResolution: chainConfig ? createDisputeResolutionFromConfig(chainConfig) : undefined,
  auditorStaking: stakingPort ?? undefined,
  disputes: disputeRepository,
  findingStatus: actionStore,
});

/** Runs the payout keeper only when a chain is configured. */
let payoutKeeper: PayoutKeeper | undefined;
/** Applies sandbox verdicts on-chain; runs only when a chain is configured. */
let verdictLoop: PayoutKeeper | undefined;
/** Moves finding statuses from contract events; runs only with a chain and a DB. */
let indexer: EventIndexerHandle | null = null;
const port = Number(process.env.PORT ?? 3001);

// app.ts builds Fastify with `logger: false` (keeps tests quiet), so
// lifecycle messages go to the console directly.
async function start(): Promise<void> {
  if (pool && migrateOnBoot) {
    const applied = await runMigrations(pool);
    console.log(`@bbm/api applied migrations: ${applied.join(", ") || "(none)"}`);
  }
  await app.listen({ port, host: "0.0.0.0" });
  console.log(`@bbm/api listening on port ${port}`);
  if (
    chainActions &&
    pool &&
    chainConfig &&
    contractRepository &&
    pipelineRepository &&
    disputeRepository
  ) {
    const db = pool;
    indexer = startEventIndexer({
      config: chainConfig,
      repository: new PgIndexerRepository(db),
      findingStatus: new PgChainActionStore(db, {
        challengeWindowSeconds: chainConfig.challengeWindowSeconds,
      }),
      listFindingIds: () => listFindingIds(db),
      lock: new PgIndexerLock(db),
      pollIntervalMs: parseIntEnv(process.env.INDEXER_POLL_MS, 5000),
      // A payout or a resolved dispute releases the auditor's claim lock once;
      // a dispute that ended on-chain is recorded, and a lost one ends the claim.
      onStatusApplied: composeStatusHooks(
        claimLockReleaser(chainActions),
        disputeSettler(disputeRepository, chainConfig.arbiterAddress, () => new Date()),
        rejectedClaimEnder({
          contracts: contractRepository,
          pipeline: pipelineRepository,
          now: () => new Date(),
        }),
      ),
    });
    const pipeline = pipelineRepository;
    verdictLoop = startVerdictLoop({
      intervalMs: parseIntEnv(process.env.VERDICT_INTERVAL_MS, 2000),
      runOnce: async () => {
        const summary = await runVerdictsOnce({ pipeline, chainActions });
        if (summary.applied + summary.failed > 0)
          console.log(`@bbm/api verdict pass: ${JSON.stringify(summary)}`);
      },
      onError: (err) => console.error("@bbm/api verdict pass failed", err),
    });
  }
  if (chainActions) {
    const intervalSeconds = parseIntEnv(process.env.PAYOUT_KEEPER_INTERVAL_SECONDS, 60);
    payoutKeeper = startPayoutKeeper({
      intervalMs: intervalSeconds * 1000,
      runOnce: async () => {
        // Finish unlocks left in 'unlocking' first. A failure is logged here so
        // the payout pass still runs.
        await chainActions
          .finishPendingUnlocks()
          .catch((err: unknown) => console.error("@bbm/api unlock sweep failed", err));
        const summary = await chainActions.runPayoutsOnce(new Date());
        if (summary.due > 0) console.log(`@bbm/api payout pass: ${JSON.stringify(summary)}`);
      },
      onError: (err) => console.error("@bbm/api payout pass failed", err),
    });
  }
}

/** How long a graceful shutdown may take before the process is forced out. */
const SHUTDOWN_TIMEOUT_MS = 10_000;

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) {
    console.error(`@bbm/api received ${signal} again, forcing exit`);
    process.exit(1);
  }
  shuttingDown = true;
  console.log(`@bbm/api received ${signal}, shutting down`);
  setTimeout(() => {
    console.error(
      `@bbm/api shutdown did not finish within ${SHUTDOWN_TIMEOUT_MS} ms, forcing exit`,
    );
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();
  try {
    await indexer?.stop();
    await verdictLoop?.stop();
    await payoutKeeper?.stop();
    await app.close();
    await pool?.end();
    process.exit(0);
  } catch (err) {
    console.error("@bbm/api shutdown failed", err);
    process.exit(1);
  }
}

process.on("SIGTERM", (signal) => void shutdown(signal));
process.on("SIGINT", (signal) => void shutdown(signal));

start().catch((err: unknown) => {
  console.error("@bbm/api failed to start", err);
  process.exit(1);
});
