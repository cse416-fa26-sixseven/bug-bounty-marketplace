import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { DisputeRulingSchema, type AuditorProfile, type Dispute } from "@bbm/shared";
import { getAddress, isAddress, type Address } from "viem";
import type { Auth } from "../auth/session.js";
import type { ChainActions } from "../chain/actions.js";
import type { AuditorStakingPort } from "../chain/auditor-staking.js";
import type { BountyEscrowPort } from "../chain/bounty-escrow.js";
import type { DisputeResolutionPort } from "../chain/dispute-resolution.js";
import { onchainId } from "../chain/ids.js";
import type { ContractRepository } from "../contracts/repository.js";
import type { PipelineRepository } from "../pipeline/repository.js";
import {
  applyFindingTransition,
  type FindingStatusReader,
  type FindingStatusWriter,
} from "../status/finding-writer.js";
import { InvalidTransitionError } from "../status/transitions.js";
import type { DisputeRepository } from "./repository.js";

export interface FindingLifecycleDeps {
  contracts: ContractRepository;
  pipeline: PipelineRepository;
  disputes: DisputeRepository;
  findingStatus: FindingStatusReader & FindingStatusWriter;
  bountyEscrow: Pick<BountyEscrowPort, "readBounty"> &
    Partial<Pick<BountyEscrowPort, "pendingPayouts">>;
  disputeResolution: Pick<DisputeResolutionPort, "getDispute">;
  auditorStaking: Pick<AuditorStakingPort, "stakeOf" | "reputation" | "activeSubmissions">;
  /** Releases the auditor's claim lock once a dispute resolves. */
  chainActions?: Pick<ChainActions, "applyDisputeResolved">;
  arbiter: Address;
  auth: Auth;
  now: () => Date;
}

/**
 * Chain-mode routes for auditors, developers and the arbiter around a finding:
 * the auditor profile (read from AuditorStaking/BountyEscrow), false
 * positives, and disputes and rulings, which the developer and the arbiter
 * sign on-chain first. Status moves go through the status machine, so a move
 * the indexer already made is a no-op.
 */
export function registerFindingLifecycleRoutes(
  app: FastifyInstance,
  deps: FindingLifecycleDeps,
): void {
  const {
    contracts,
    pipeline,
    disputes,
    findingStatus,
    bountyEscrow,
    disputeResolution,
    auditorStaking,
    auth,
    now,
  } = deps;

  app.get("/api/auditor/profile", async (request, reply) => {
    const address = auth.requireSession(request, reply);
    if (!address) return reply;
    const [stake, reputation, active, pending, claimed] = await Promise.all([
      auditorStaking.stakeOf(address),
      auditorStaking.reputation(address),
      auditorStaking.activeSubmissions(address),
      bountyEscrow.pendingPayouts?.(address),
      contracts.listClaimedContractIds(address, now()),
    ]);
    const profile: AuditorProfile = {
      id: address,
      address,
      stake: stake.toString(),
      reputation: Number(reputation),
      claimedContractIds: claimed,
      activeSubmissions: Number(active),
      ...(pending !== undefined ? { pendingPayout: pending.toString() } : {}),
    };
    return profile;
  });

  app.post<{ Params: { id: string } }>(
    "/api/findings/:id/false-positive",
    async (request, reply) => {
      const address = auth.requireSession(request, reply);
      if (!address) return reply;
      const finding = await pipeline.findFinding(request.params.id, now());
      if (!finding) return reply.code(404).send({ error: "Finding not found" });
      const claim = await contracts.findActiveClaim(finding.contractId, now());
      if (!claim || claim.auditorId.toLowerCase() !== address.toLowerCase()) {
        return reply
          .code(403)
          .send({ error: "only the auditor holding the claim can mark a false positive" });
      }
      const result = await pipeline.markFalsePositive(finding.id, now().toISOString());
      if (result === "not_flagged")
        return reply.code(409).send({ error: "only a Flagged finding can be a false positive" });
      if (result === "not_found") return reply.code(404).send({ error: "Finding not found" });
      const { contract: _contract, ...updated } = (await pipeline.findFinding(finding.id, now()))!;
      return updated;
    },
  );

  app.post<{ Params: { id: string }; Body: { reason?: unknown } | undefined }>(
    "/api/findings/:id/dispute",
    async (request, reply) => {
      const address = auth.requireSession(request, reply);
      if (!address) return reply;
      const reason = request.body?.reason;
      if (typeof reason !== "string" || reason.trim() === "") {
        return reply.code(400).send({ error: "reason is required" });
      }
      const finding = await pipeline.findFinding(request.params.id, now());
      if (!finding) return reply.code(404).send({ error: "Finding not found" });
      if (
        !isAddress(finding.contract.developerAddress) ||
        getAddress(finding.contract.developerAddress) !== address
      ) {
        return reply.code(403).send({ error: "only the contract's developer can dispute" });
      }
      const onchain = await disputeResolution.getDispute(
        onchainId(finding.contractId),
        onchainId(finding.id),
      );
      if (!onchain || onchain.resolved) {
        return reply.code(409).send({ error: "no open dispute on-chain for this finding" });
      }
      const openedAt = now().toISOString();
      const dispute = await disputes.create({
        id: `dispute_${randomUUID()}`,
        findingId: finding.id,
        contractId: finding.contractId,
        developerId: address,
        reason: reason.trim(),
        openedAt,
        challengeWindowExpiresAt: finding.challengeWindowExpiresAt ?? openedAt,
        ruling: "Pending",
        ruledAt: null,
        arbiterId: null,
      });
      await moveFinding(finding.id, "Disputed");
      return reply.code(201).send(dispute);
    },
  );

  app.get<{ Querystring: { ruling?: string } }>("/api/arbiter/disputes", async (request, reply) => {
    if (!requireArbiter(request, reply)) return reply;
    const parsed = DisputeRulingSchema.safeParse(request.query.ruling);
    const list = await disputes.list(parsed.success ? parsed.data : undefined);
    return Promise.all(
      list.map(async (dispute) => {
        const found = await pipeline.findFinding(dispute.findingId, now());
        const finding = found ? (({ contract: _c, ...rest }) => rest)(found) : null;
        return {
          ...dispute,
          finding,
          pocSubmission: await pipeline.findLatestPoc(dispute.findingId),
        };
      }),
    );
  });

  app.post<{ Params: { id: string }; Body: { ruling?: unknown } | undefined }>(
    "/api/arbiter/disputes/:id/rule",
    async (request, reply) => {
      const arbiter = requireArbiter(request, reply);
      if (!arbiter) return reply;
      const ruling = request.body?.ruling;
      if (ruling !== "ForAuditor" && ruling !== "AgainstAuditor") {
        return reply.code(400).send({ error: "ruling must be ForAuditor or AgainstAuditor" });
      }
      const dispute = await disputes.findById(request.params.id);
      if (!dispute) return reply.code(404).send({ error: "Dispute not found" });
      // The indexer may record the on-chain outcome first; the same ruling again
      // succeeds, and still retries the stake unlock (idempotent) in case the
      // indexer's attempt failed.
      if (dispute.ruling === ruling) {
        await releaseLockIfLost(request, dispute.findingId, ruling);
        return dispute;
      }
      if (dispute.ruling !== "Pending")
        return reply.code(409).send({ error: "Dispute already ruled" });
      const finding = await pipeline.findFinding(dispute.findingId, now());
      if (!finding) return reply.code(404).send({ error: "Finding not found" });

      const contractKey = onchainId(finding.contractId);
      const findingKey = onchainId(finding.id);
      const onchain = await disputeResolution.getDispute(contractKey, findingKey);
      if (!onchain?.resolved) return reply.code(409).send({ error: "rule on-chain first" });
      const bounty = await bountyEscrow.readBounty(contractKey);
      const auditorWon = bounty.verifiedFinding.toLowerCase() === findingKey.toLowerCase();
      if ((ruling === "ForAuditor") !== auditorWon) {
        return reply.code(409).send({
          error: `the on-chain ruling was ${auditorWon ? "ForAuditor" : "AgainstAuditor"}`,
        });
      }

      const ruled: Dispute | null = await disputes.setRuling(dispute.id, ruling, arbiter, now());
      if (!ruled) {
        const current = await disputes.findById(dispute.id);
        if (current?.ruling === ruling) return current;
        return reply.code(409).send({ error: "Dispute already ruled" });
      }
      await moveFinding(finding.id, auditorWon ? "Verified" : "Rejected");
      await releaseLockIfLost(request, finding.id, ruling);
      return ruled;
    },
  );

  /** A ruling against the auditor rejects the finding, so its claim lock is
   * released. A ruling for the auditor returns it to Verified: the lock stays
   * until PayoutCredited, since the payout reverts AuditorNotEligible if the
   * auditor withdrew the stake in between. */
  async function releaseLockIfLost(
    request: FastifyRequest,
    findingId: string,
    ruling: "ForAuditor" | "AgainstAuditor",
  ): Promise<void> {
    if (ruling !== "AgainstAuditor") return;
    await deps.chainActions?.applyDisputeResolved(findingId).catch((err: unknown) => {
      request.log.error({ err, findingId }, "applyDisputeResolved failed; the expiry sweep will release it");
    });
  }

  /** The signed-in arbiter's address, or sends 401/403. */
  function requireArbiter(
    request: Parameters<Auth["requireSession"]>[0],
    reply: Parameters<Auth["requireSession"]>[1],
  ): Address | undefined {
    const address = auth.requireSession(request, reply);
    if (!address) return undefined;
    if (address !== getAddress(deps.arbiter)) {
      void reply.code(403).send({ error: "only the arbiter can do this" });
      return undefined;
    }
    return address;
  }

  /** Moves the finding through the status machine; a move the indexer already
   * made (or went past) is not an error here. */
  async function moveFinding(
    findingId: string,
    next: "Disputed" | "Verified" | "Rejected",
  ): Promise<void> {
    try {
      await applyFindingTransition(findingStatus, findingId, next, now().toISOString());
    } catch (err) {
      if (!(err instanceof InvalidTransitionError)) throw err;
    }
  }
}
