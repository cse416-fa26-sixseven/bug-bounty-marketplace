import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  AUDITOR_FINDING_DETECTOR,
  AuditorFindingFieldsSchema,
  compareWei,
  type AuditorFindingReport,
  type PoCSubmission,
  PocSourceFilenameSchema,
  PocSourceSizeSchema,
} from "@bbm/shared";
import type { ContractRepository, QueueItem } from "../contracts/repository.js";
import type { SourceStorage } from "../contracts/storage.js";
import { readMultipart } from "../http/multipart.js";
import type { AuditorStakingPort } from "../chain/auditor-staking.js";
import type { ChainActions } from "../chain/actions.js";
import type { PipelineConfig } from "./config.js";
import { canTransitionFinding } from "../status/transitions.js";
import { toFinding } from "./mapping.js";
import { registerDeveloperNoteRoutes } from "./note-routes.js";
import type { FindingRecord, NewJob, PipelineRepository } from "./repository.js";
import type { PocVerdictSource } from "./verdict-source.js";
import { resolveActor, type Auth } from "../auth/session.js";

/** Minimum AuditorStaking.stakeOf an auditor needs before a PoC is accepted:
 * 0.1 ETH, matching AuditorStaking.REQUIRED_STAKE. */
export const REQUIRED_STAKE_WEI = "100000000000000000";

export interface PipelineRouteDeps {
  contracts: ContractRepository;
  pipeline: PipelineRepository;
  storage: SourceStorage;
  config: PipelineConfig;
  /** Present only when a chain is configured. Claims lock the auditor's stake
   * and release it on expiry, through the chain actions. */
  chainActions?: ChainActions;
  /** Read-only stake source for the PoC stake gate. Null when no chain is
   * configured: the gate is then skipped and logged. Independent of the
   * claim-lock flag. */
  stakeReader: Pick<AuditorStakingPort, "stakeOf"> | null;
  /** Sandbox verdict source for PoC uploads. */
  verdicts: PocVerdictSource;
  /** With a chain configured: claims and PoCs act for the signed-in auditor,
   * and the queue lists only bounties funded on-chain. */
  identity?: Auth | null;
}

const ADDRESS = /^0x[a-fA-F0-9]{40}$/;

const QUEUE_SORTS = ["deadline", "bounty", "newest"] as const;
type QueueSort = (typeof QUEUE_SORTS)[number];

function sortQueue(items: QueueItem[], sort: QueueSort | undefined): QueueItem[] {
  const by: Record<QueueSort, (a: QueueItem, b: QueueItem) => number> = {
    deadline: (a, b) => a.deadline.localeCompare(b.deadline),
    bounty: (a, b) => compareWei(b.bounty.amount, a.bounty.amount),
    newest: (a, b) => b.createdAt.localeCompare(a.createdAt),
  };
  return sort ? [...items].sort(by[sort]) : items;
}

/** Storage key for an uploaded PoC, content-addressed like contract sources. */
export function pocStorageKey(pocId: string, sha256: string): string {
  return `pocs/${pocId}/${sha256}.t.sol`;
}

/** Routes backed by the analysis pipeline: findings, analysis status, the
 * auditor queue and claims, and PoC submission. */
export function registerPipelineRoutes(app: FastifyInstance, deps: PipelineRouteDeps): void {
  const { contracts, pipeline, storage, config, chainActions, stakeReader, verdicts } = deps;
  const identity = deps.identity ?? null;
  registerDeveloperNoteRoutes(app, { pipeline, config, identity });

  app.get<{ Params: { id: string } }>("/api/contracts/:id/findings", async (request, reply) => {
    const now = config.now();
    const contract = await contracts.findContractById(request.params.id, now);
    if (!contract) return reply.code(404).send({ error: "Not found" });
    return pipeline.listFindings(contract.id, now);
  });

  app.get<{ Params: { id: string } }>("/api/contracts/:id/analysis", async (request, reply) => {
    const status = await pipeline.getAnalysisStatus(request.params.id);
    if (!status) return reply.code(404).send({ error: "Not found" });
    return status;
  });

  app.get<{ Params: { id: string } }>("/api/findings/:id/raw", async (request, reply) => {
    const raw = await pipeline.getRawOutput(request.params.id);
    if (raw === null) return reply.code(404).send({ error: "Not found" });
    return reply.type("application/json").send(JSON.stringify(raw));
  });

  app.get<{ Querystring: { sort?: string } }>("/api/auditor/queue", async (request, reply) => {
    const sort = request.query.sort || undefined;
    if (sort !== undefined && !(QUEUE_SORTS as readonly string[]).includes(sort)) {
      return reply.code(400).send({ error: `sort must be one of ${QUEUE_SORTS.join(", ")}` });
    }
    const now = config.now();
    if (chainActions) {
      // Lazy expiry: the first queue read after a claim lapses releases its lock.
      await chainActions.releaseExpiredLocks(now).catch((err: unknown) => {
        request.log.error({ err }, "releaseExpiredLocks failed");
      });
    }
    return sortQueue(await contracts.listQueue(now, { fundedOnly: identity !== null }), sort as QueueSort | undefined);
  });

  app.post<{ Body: { contractId?: unknown; auditorId?: unknown } | undefined }>(
    "/api/auditor/claim",
    async (request, reply) => {
      const actor = resolveActor(identity, request, reply, request.body?.auditorId);
      if (!actor.ok) return reply;
      const contractId = request.body?.contractId;
      const auditorId = actor.id;
      if (
        typeof contractId !== "string" ||
        !contractId ||
        typeof auditorId !== "string" ||
        !auditorId
      ) {
        return reply.code(400).send({ error: "contractId and auditorId are required" });
      }
      // With a chain configured, the auditorId is the auditor's on-chain
      // address, so reject anything else before the claim is written.
      if ((stakeReader !== null || chainActions?.chainConfigured) && !ADDRESS.test(auditorId)) {
        return reply.code(400).send({ error: "auditorId must be a 0x-prefixed address" });
      }
      const now = config.now();
      const expiresAt = new Date(now.getTime() + config.claimWindowSeconds * 1000);
      if (chainActions) {
        // A new claim overwrites the row, so a lapsed lock must be released
        // first or it would never be unlocked.
        try {
          await chainActions.releaseExpiredLocks(now, contractId);
        } catch (err) {
          request.log.error({ err, contractId }, "releaseExpiredLocks failed; claim not applied");
          return reply
            .code(502)
            .send({ error: "Could not release the previous claim's on-chain lock; claim not applied" });
        }
      }
      // Auditors only see analysed contracts, in every mode; a failed analysis
      // (it does not compile) never becomes claimable.
      if (!(await contracts.isAnalysisDone(contractId))) {
        return (await contracts.findContractById(contractId, now))
          ? reply.code(409).send({ error: "analysis not finished" })
          : reply.code(404).send({ error: "Not found" });
      }
      // With a chain, only a bounty confirmed funded on-chain can be claimed:
      // its PoC verdict is recorded on BountyEscrow.
      if (identity && !(await contracts.isFunded(contractId))) {
        return reply.code(409).send({ error: "bounty not funded on-chain" });
      }
      const result = await contracts.claimContract(contractId, auditorId, expiresAt, now);
      if (!result.ok) {
        if (result.reason === "not_found") return reply.code(404).send({ error: "Not found" });
        if (result.reason === "auditor_has_claim") {
          return reply.code(409).send({ error: "auditor already holds an active claim" });
        }
        return reply.code(409).send({ error: `Contract ${contractId} is not open to claim` });
      }
      if (!chainActions) return result.contract;

      // Claim first (the repository decides the race), then lock. If the lock
      // fails, roll the claim back so the contract reopens and no unlocked
      // claim is left standing. If the rollback itself fails, the claim still
      // expires after the claim window.
      try {
        await chainActions.lockClaim(contractId, auditorId);
      } catch (err) {
        request.log.error({ err, contractId, auditorId }, "lockSubmission failed; releasing claim");
        await contracts.releaseClaim(contractId, auditorId).catch((releaseErr: unknown) => {
          request.log.error({ err: releaseErr, contractId, auditorId }, "releaseClaim failed");
        });
        return reply.code(502).send({ error: "Could not lock the auditor stake on-chain; claim not applied" });
      }
      return result.contract;
    },
  );

  app.post("/api/auditor/poc", async (request, reply) => {
    const body = await readMultipart(request);
    if (!body.ok) {
      return body.reason === "too_large"
        ? reply.code(413).send({ error: "PoC file exceeds the 100 KB limit" })
        : reply.code(400).send({ error: "Expected a multipart/form-data body" });
    }
    const actor = resolveActor(identity, request, reply, body.fields.auditorId);
    if (!actor.ok) return reply;
    const findingId = body.fields.findingId;
    const auditorId = actor.id;
    if (!findingId || !auditorId || !body.file) {
      return reply.code(400).send({ error: "findingId, auditorId and file are required" });
    }
    // Checked before the claim, so a non-address id is a 400 whatever the claim state.
    if ((stakeReader !== null || chainActions?.chainConfigured) && !ADDRESS.test(auditorId)) {
      return reply.code(400).send({ error: "auditorId must be a 0x-prefixed address" });
    }
    const issues = pocFileIssues(body.file);
    if (issues.length > 0) {
      return reply.code(400).send({ error: "Invalid PoC submission", issues });
    }

    const now = config.now();
    const finding = await pipeline.findFinding(findingId, now);
    if (!finding) return reply.code(404).send({ error: "Not found" });
    const claim = await contracts.findActiveClaim(finding.contractId, now);
    if (!claim || claim.auditorId !== auditorId) {
      return reply.code(403).send({ error: NO_CLAIM });
    }
    if (!canTransitionFinding(finding.status, "Submitted")) {
      return reply.code(409).send({ error: "Finding is not Flagged" });
    }

    if (!(await passesStakeGate("POST /api/auditor/poc", auditorId, reply))) return reply;

    const poc = await storePoc(findingId, auditorId, body.file.bytes, now);
    const outcome = await pipeline.submitPoc({
      poc,
      findingId,
      now: poc.submittedAt,
      job: sandboxJob(poc),
    });
    if (outcome === "no_claim") {
      return reply.code(403).send({ error: NO_CLAIM });
    }
    if (outcome === "not_flagged") {
      return reply.code(409).send({ error: "Finding is not Flagged" });
    }
    return reply.code(201).send(await withVerdict(poc));
  });

  // US5: the auditor holding the claim reports a finding Slither missed,
  // with the PoC that proves it. Same checks as a PoC upload; the finding is
  // born Submitted and follows the same sandbox → Verified/Rejected path.
  app.post("/api/auditor/findings", async (request, reply) => {
    const body = await readMultipart(request);
    if (!body.ok) {
      return body.reason === "too_large"
        ? reply.code(413).send({ error: "PoC file exceeds the 100 KB limit" })
        : reply.code(400).send({ error: "Expected a multipart/form-data body" });
    }
    const actor = resolveActor(identity, request, reply, body.fields.auditorId);
    if (!actor.ok) return reply;
    const auditorId = actor.id;
    const { contractId, title, severity, description } = body.fields;
    if (!contractId || !auditorId || !title || !severity || !description || !body.file) {
      return reply.code(400).send({
        error: "contractId, auditorId, title, severity, description and file are required",
      });
    }
    if ((stakeReader !== null || chainActions?.chainConfigured) && !ADDRESS.test(auditorId)) {
      return reply.code(400).send({ error: "auditorId must be a 0x-prefixed address" });
    }
    const fields = AuditorFindingFieldsSchema.safeParse({ contractId, title, severity, description });
    const issues = [
      ...(fields.error?.issues.map((issue) => issue.message) ?? []),
      ...pocFileIssues(body.file),
    ];
    if (!fields.success || issues.length > 0) {
      return reply.code(400).send({ error: "Invalid finding report", issues });
    }
    const report = fields.data;

    const now = config.now();
    const contract = await contracts.findContractById(report.contractId, now);
    if (!contract) return reply.code(404).send({ error: "Not found" });
    const claim = await contracts.findActiveClaim(contract.id, now);
    if (!claim || claim.auditorId !== auditorId) {
      return reply.code(403).send({ error: NO_CLAIM });
    }

    if (!(await passesStakeGate("POST /api/auditor/findings", auditorId, reply))) return reply;

    const findingId = `finding_${randomUUID()}`;
    const poc = await storePoc(findingId, auditorId, body.file.bytes, now);
    const at = poc.submittedAt;
    const finding: FindingRecord = {
      id: findingId,
      contractId: contract.id,
      severity: report.severity,
      slitherDetector: AUDITOR_FINDING_DETECTOR,
      slitherConfidence: "n/a",
      // GET /api/findings/:id/raw returns the report as submitted.
      rawOutput: {
        source: "auditor",
        reportedByAuditorId: auditorId,
        title: report.title,
        severity: report.severity,
        description: report.description,
      },
      rawOutputReference: `/api/findings/${findingId}/raw`,
      llmExplanation: report.description,
      explanationSource: "auditor",
      status: "Submitted",
      statusHistory: [{ status: "Submitted", changedAt: at }],
      isFalsePositive: false,
      challengeWindowExpiresAt: null,
      createdAt: at,
      source: "auditor",
      title: report.title,
      reportedByAuditorId: auditorId,
      developerNote: null,
      developerNoteUpdatedAt: null,
    };
    const outcome = await pipeline.submitAuditorFinding({
      finding,
      poc,
      job: sandboxJob(poc),
      now: at,
    });
    if (outcome === "no_claim") {
      return reply.code(403).send({ error: NO_CLAIM });
    }
    const created: AuditorFindingReport = {
      finding: toFinding(finding, claim),
      poc: await withVerdict(poc),
    };
    return reply.code(201).send(created);
  });

  function pocFileIssues(file: { filename: string; bytes: Buffer }): string[] {
    return [
      ...(PocSourceFilenameSchema.safeParse(file.filename).error?.issues ?? []),
      ...(PocSourceSizeSchema.safeParse(file.bytes.byteLength).error?.issues ?? []),
    ].map((issue) => issue.message);
  }

  /** Stake gate: checked before any bytes are stored, so a rejected upload
   * leaves nothing behind. Sends the error reply and returns false on failure. */
  async function passesStakeGate(
    route: string,
    auditorId: string,
    reply: FastifyReply,
  ): Promise<boolean> {
    if (stakeReader === null) {
      // Not a silent pass: every skipped check is logged so a deployment
      // without CHAIN_RPC_URL shows up in the logs.
      console.warn(`${route}: stake check skipped for ${auditorId}, no chain configured`);
      return true;
    }
    if (!ADDRESS.test(auditorId)) {
      void reply
        .code(400)
        .send({ error: "auditorId must be the auditor's 0x wallet address for the stake check" });
      return false;
    }
    const stake = (await stakeReader.stakeOf(auditorId as `0x${string}`)).toString();
    if (compareWei(stake, REQUIRED_STAKE_WEI) < 0) {
      void reply.code(403).send({ error: "Auditor stake is below the required stake" });
      return false;
    }
    return true;
  }

  /** Stores the PoC bytes and returns its Pending submission. Bytes first,
   * row second: a failed insert leaves an orphan object rather than a row
   * pointing at nothing (same rule as contract uploads). */
  async function storePoc(
    findingId: string,
    auditorId: string,
    bytes: Buffer,
    now: Date,
  ): Promise<PoCSubmission> {
    const pocId = `poc_${randomUUID()}`;
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const testFileReference = pocStorageKey(pocId, sha256);
    await storage.put(testFileReference, bytes);
    return {
      id: pocId,
      findingId,
      auditorId,
      testFileReference,
      submittedAt: now.toISOString(),
      sandboxStatus: "Pending",
      sandboxLog: null,
    };
  }

  /** The stored row is Pending until a verdict exists. Only a decided verdict
   * is written back; the queued sandbox job is left as it is. */
  async function withVerdict(poc: PoCSubmission): Promise<PoCSubmission> {
    const sandboxStatus = await verdicts.requestVerdict({ ...poc });
    if (sandboxStatus !== "Pending") {
      await pipeline.recordVerdict(poc.id, sandboxStatus);
    }
    return { ...poc, sandboxStatus };
  }
}

const NO_CLAIM = "You do not hold an active claim on this contract";

function sandboxJob(poc: PoCSubmission): NewJob {
  return { id: `job_${randomUUID()}`, kind: "sandbox", subjectId: poc.id, createdAt: poc.submittedAt };
}
