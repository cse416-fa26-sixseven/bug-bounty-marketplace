import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { MemoryContractRepository } from "./contracts/memory-repository.js";
import type { ContractRepository } from "./contracts/repository.js";
import { registerContractRoutes, CONTRACT_MULTIPART_LIMITS } from "./contracts/routes.js";
import { MemorySourceStorage, type SourceStorage } from "./contracts/storage.js";
import type { AuditorStakingPort } from "./chain/auditor-staking.js";
import type { ChainActions } from "./chain/actions.js";
import type { ChainConfig } from "./chain/config.js";
import { registerChainRoutes } from "./chain/routes.js";
import { Auth } from "./auth/session.js";
import { registerAuthRoutes } from "./auth/routes.js";
import type { BountyEscrowPort } from "./chain/bounty-escrow.js";
import { registerContractLifecycleRoutes } from "./contracts/lifecycle-routes.js";
import type { DisputeResolutionPort } from "./chain/dispute-resolution.js";
import { MemoryChainActionStore } from "./chain/memory-action-store.js";
import { MemoryDisputeRepository } from "./disputes/memory-repository.js";
import type { DisputeRepository } from "./disputes/repository.js";
import { registerFindingLifecycleRoutes } from "./disputes/routes.js";
import type { FindingStatusReader, FindingStatusWriter } from "./status/finding-writer.js";
import { loadPipelineConfig, type PipelineConfig } from "./pipeline/config.js";
import { MemoryPipelineRepository, MemoryStore } from "./pipeline/memory-repository.js";
import type { PipelineRepository } from "./pipeline/repository.js";
import { registerPipelineRoutes } from "./pipeline/routes.js";
import { NotConfiguredVerdictSource, type PocVerdictSource } from "./pipeline/verdict-source.js";
import { registerRateLimit, type RateLimitConfig } from "./http/rate-limit.js";

export interface AppOptions {
  /** Defaults to an in-memory repository. `index.ts` wires Postgres when
   * DATABASE_URL is set. Pass `repository` and `pipeline` together so they
   * share the same data. */
  repository?: ContractRepository;
  /** Defaults to in-memory findings/PoCs/jobs. Nothing processes in-memory
   * jobs; the analysis worker needs Postgres. */
  pipeline?: PipelineRepository;
  /** Defaults to in-memory object storage. `index.ts` wires local disk when
   * SOURCE_STORAGE_DIR is set. */
  storage?: SourceStorage;
  /** Defaults to loadPipelineConfig() (env vars, real clock). */
  config?: PipelineConfig;
  /** Read-only AuditorStaking reader for the PoC stake gate. Omit or pass null
   * when no chain is configured: the gate is then skipped and logged. Independent
   * of CLAIM_LOCK_ENABLED. */
  stakeReader?: Pick<AuditorStakingPort, "stakeOf"> | null;
  /** Sandbox verdict source for PoC uploads. Defaults to NotConfiguredVerdictSource,
   * which leaves every PoC Pending. */
  verdicts?: PocVerdictSource;
  /** Omit when no chain is configured. Claims then skip the on-chain lock,
   * and no verdict or payout is sent. */
  chainActions?: ChainActions;
  /** The chain the API talks to, or null/omitted for none. Served to the
   * browser by GET /api/chain. */
  chainConfig?: ChainConfig | null;
  /** HMAC secret for session cookies (SESSION_SECRET). With it, the API serves
   * signed-message sign-in and user routes act for the signed-in address. */
  sessionSecret?: string;
  /** Clock for sign-in; defaults to the pipeline config's clock. */
  now?: () => Date;
  /** BountyEscrow reads for the developer lifecycle routes. With it and a
   * session secret, the API is in chain mode: user routes act for the
   * signed-in wallet and confirm user transactions on-chain. */
  bountyEscrow?: Pick<BountyEscrowPort, "readBounty"> & Partial<Pick<BountyEscrowPort, "pendingPayouts">>;
  /** DisputeResolution reads for disputes and rulings (chain mode). */
  disputeResolution?: Pick<DisputeResolutionPort, "getDispute">;
  /** AuditorStaking reads for the auditor profile (chain mode). */
  auditorStaking?: Pick<AuditorStakingPort, "stakeOf" | "reputation">;
  /** Defaults to an in-memory store. */
  disputes?: DisputeRepository;
  /** Guarded finding status writes (the chain action store). Defaults to an
   * in-memory store over the same data as the default repositories. */
  findingStatus?: FindingStatusReader & FindingStatusWriter;
  /** Per-client-IP request limits. Omit for none (tests); `index.ts` passes
   * loadRateLimitConfig(), which is on by default. */
  rateLimit?: RateLimitConfig;
  /** Fastify `trustProxy`: which proxies' X-Forwarded-For to believe when
   * working out the client IP (TRUST_PROXY, see parseTrustProxy). Default
   * false: the client is the socket peer. */
  trustProxy?: false | string[];
}

export function buildApp(options: AppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false, trustProxy: options.trustProxy ?? false });

  if (options.rateLimit) registerRateLimit(app, options.rateLimit);
  void app.register(multipart, { limits: CONTRACT_MULTIPART_LIMITS });
  // Routes are declared in a plugin so they are added after the rate limiter
  // has loaded; routes declared directly on `app` here would skip it.
  void app.register(async (api) => registerRoutes(api, options));

  return app;
}

function registerRoutes(app: FastifyInstance, options: AppOptions): void {
  // Probes must never be throttled.
  app.get("/health", { config: { rateLimit: false } }, async () => {
    return { status: "ok" };
  });

  const store = new MemoryStore();
  const repository = options.repository ?? new MemoryContractRepository(store);
  const pipeline = options.pipeline ?? new MemoryPipelineRepository(store);
  const storage = options.storage ?? new MemorySourceStorage();
  const config = options.config ?? loadPipelineConfig();

  registerChainRoutes(app, { config: options.chainConfig ?? null });
  const auth = options.sessionSecret ? new Auth(options.sessionSecret, options.now ?? config.now) : null;
  if (auth) registerAuthRoutes(app, auth);
  // Chain mode: identities come from the session, user transactions are confirmed on-chain.
  const identity = auth && options.bountyEscrow ? auth : null;
  registerContractRoutes(app, { repository, storage, now: config.now, identity });
  if (identity && options.bountyEscrow) {
    registerContractLifecycleRoutes(app, {
      contracts: repository,
      bountyEscrow: options.bountyEscrow,
      auth: identity,
      now: options.now ?? config.now,
      chainActions: options.chainActions,
    });
    if (options.disputeResolution && options.auditorStaking && options.chainConfig) {
      registerFindingLifecycleRoutes(app, {
        contracts: repository,
        pipeline,
        disputes: options.disputes ?? new MemoryDisputeRepository(),
        findingStatus: options.findingStatus ?? new MemoryChainActionStore(store),
        bountyEscrow: options.bountyEscrow,
        disputeResolution: options.disputeResolution,
        auditorStaking: options.auditorStaking,
        chainActions: options.chainActions,
        arbiter: options.chainConfig.arbiterAddress,
        auth: identity,
        now: options.now ?? config.now,
      });
    }
  }
  registerPipelineRoutes(app, {
    contracts: repository,
    pipeline,
    storage,
    config,
    stakeReader: options.stakeReader ?? null,
    verdicts: options.verdicts ?? new NotConfiguredVerdictSource(),
    chainActions: options.chainActions,
    identity,
  });
}
