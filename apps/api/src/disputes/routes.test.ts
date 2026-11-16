import { describe, expect, it, vi } from "vitest";
import type { Address, Hex } from "viem";
import type { FindingStatus } from "@bbm/shared";
import { buildApp } from "../app.js";
import type { BountyEscrowPort, OnchainBounty } from "../chain/bounty-escrow.js";
import type { ChainConfig } from "../chain/config.js";
import type { OnchainDispute } from "../chain/dispute-resolution.js";
import { onchainId } from "../chain/ids.js";
import { MemoryChainActionStore } from "../chain/memory-action-store.js";
import { MemoryContractRepository } from "../contracts/memory-repository.js";
import { MemoryDisputeRepository } from "./memory-repository.js";
import { MemoryPipelineRepository, MemoryStore } from "../pipeline/memory-repository.js";
import { makeContract, makeFinding } from "../testing/repository-suite.js";
import { ARBITER, AUDITOR, DEVELOPER, signIn } from "../testing/session.js";

const ZERO = `0x${"0".repeat(64)}` as Hex;
const T0 = new Date("2026-10-20T12:00:00.000Z");
const CONFIG: ChainConfig = {
  rpcUrl: "http://anvil:8545",
  publicRpcUrl: null,
  chainId: 31337,
  operatorPrivateKey: `0x${"11".repeat(32)}`,
  auditorStakingAddress: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
  bountyEscrowAddress: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
  disputeResolutionAddress: "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0",
  arbiterAddress: ARBITER.address,
  challengeWindowSeconds: 60,
};

function setup() {
  const clock = { now: T0 };
  const store = new MemoryStore();
  const repository = new MemoryContractRepository(store);
  const pipeline = new MemoryPipelineRepository(store);
  const findingStatus = new MemoryChainActionStore(store, { challengeWindowSeconds: 60 });
  const disputesOnChain = new Map<string, OnchainDispute>();
  let verifiedFinding: Hex = ZERO;
  const bountyEscrow = {
    readBounty: vi.fn(async (): Promise<OnchainBounty> => ({
      developer: DEVELOPER.address,
      amount: 0n,
      deadline: 0n,
      state: 1,
      submissionCount: 1n,
      verifiedFinding,
      verifiedAuditor: AUDITOR.address,
      frozen: false,
    })),
    pendingPayouts: vi.fn(async () => 7n),
  } satisfies Pick<BountyEscrowPort, "readBounty" | "pendingPayouts">;
  const disputeResolution = {
    getDispute: vi.fn(async (c: Hex, f: Hex) => disputesOnChain.get(`${c}:${f}`) ?? null),
  };
  const auditorStaking = {
    stakeOf: vi.fn(async () => 10n ** 17n),
    reputation: vi.fn(async () => 3n),
    activeSubmissions: vi.fn(async () => 1n),
  };
  const chainActions = { applyDisputeResolved: vi.fn(async () => true) };
  const disputes = new MemoryDisputeRepository();
  const app = buildApp({
    repository,
    pipeline,
    findingStatus,
    sessionSecret: "s",
    now: () => clock.now,
    config: { now: () => clock.now, claimWindowSeconds: 600 } as never,
    chainConfig: CONFIG,
    bountyEscrow,
    disputeResolution,
    auditorStaking,
    chainActions: chainActions as never,
    disputes,
  });

  async function seed(status: FindingStatus, claimedBy: Address | null = null) {
    const record = makeContract({ developerAddress: DEVELOPER.address });
    await repository.insertContract(record);
    if (claimedBy)
      await repository.claimContract(
        record.contract.id,
        claimedBy,
        new Date(T0.getTime() + 600_000),
        T0,
      );
    const finding = makeFinding(record.contract.id, {
      status,
      statusHistory: [{ status, changedAt: T0.toISOString() }],
      challengeWindowExpiresAt:
        status === "Verified" ? new Date(T0.getTime() + 60_000).toISOString() : null,
    });
    store.findings.set(finding.id, finding);
    return { contractId: record.contract.id, findingId: finding.id };
  }
  function openOnChain(contractId: string, findingId: string, resolved = false) {
    disputesOnChain.set(`${onchainId(contractId)}:${onchainId(findingId)}`, {
      developer: DEVELOPER.address,
      auditor: AUDITOR.address,
      ruleBy: 9_999_999_999n,
      resolved,
    });
  }
  return {
    app,
    store,
    disputes,
    seed,
    openOnChain,
    chainActions,
    setVerified: (f: string) => (verifiedFinding = onchainId(f)),
  };
}

describe("auditor profile", () => {
  it("reads stake, reputation, active locks and pending payout from the chain for the signed-in auditor", async () => {
    const { app } = setup();
    const res = await app.inject({
      method: "GET",
      url: "/api/auditor/profile",
      headers: { cookie: await signIn(app, AUDITOR) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: AUDITOR.address,
      address: AUDITOR.address,
      stake: "100000000000000000",
      reputation: 3,
      pendingPayout: "7",
      activeSubmissions: 1,
      claimedContractIds: [],
    });
  });
});

describe("false positive", () => {
  it("only the claim holder can mark a Flagged finding a false positive", async () => {
    const { app, seed, store } = setup();
    const { findingId } = await seed("Flagged", AUDITOR.address);
    const dev = await app.inject({
      method: "POST",
      url: `/api/findings/${findingId}/false-positive`,
      headers: { cookie: await signIn(app, DEVELOPER) },
    });
    expect(dev.statusCode).toBe(403);
    const res = await app.inject({
      method: "POST",
      url: `/api/findings/${findingId}/false-positive`,
      headers: { cookie: await signIn(app, AUDITOR) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "Rejected", isFalsePositive: true });
    expect(store.findings.get(findingId)?.status).toBe("Rejected");
  });

  it("refuses a finding that is no longer Flagged", async () => {
    const { app, seed } = setup();
    const { findingId } = await seed("Submitted", AUDITOR.address);
    const res = await app.inject({
      method: "POST",
      url: `/api/findings/${findingId}/false-positive`,
      headers: { cookie: await signIn(app, AUDITOR) },
    });
    expect(res.statusCode).toBe(409);
  });
});

describe("disputes", () => {
  it("records a dispute only after it is open on-chain, idempotently", async () => {
    const { app, seed, openOnChain, store, disputes } = setup();
    const { contractId, findingId } = await seed("Verified");
    const cookie = await signIn(app, DEVELOPER);
    const before = await app.inject({
      method: "POST",
      url: `/api/findings/${findingId}/dispute`,
      headers: { cookie },
      payload: { reason: "the PoC only asserts true" },
    });
    expect(before.statusCode).toBe(409);
    expect(store.findings.get(findingId)?.status).toBe("Verified");

    openOnChain(contractId, findingId);
    const first = await app.inject({
      method: "POST",
      url: `/api/findings/${findingId}/dispute`,
      headers: { cookie },
      payload: { reason: "the PoC only asserts true" },
    });
    const second = await app.inject({
      method: "POST",
      url: `/api/findings/${findingId}/dispute`,
      headers: { cookie },
      payload: { reason: "again" },
    });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.json().id).toBe(first.json().id);
    expect(first.json()).toMatchObject({
      findingId,
      developerId: DEVELOPER.address,
      ruling: "Pending",
    });
    const finding = store.findings.get(findingId)!;
    expect(finding.status).toBe("Disputed");
    expect(finding.statusHistory.filter((h) => h.status === "Disputed")).toHaveLength(1);
    // The on-chain ruling window is kept for the lapse keeper.
    const pastWindow = new Date(9_999_999_999_000 + 1000);
    expect(await disputes.listLapseCandidates(pastWindow)).toEqual([
      { id: first.json().id, findingId, contractId, ruleBy: new Date(9_999_999_999_000) },
    ]);
  });

  it("only the developer can dispute", async () => {
    const { app, seed, openOnChain } = setup();
    const { contractId, findingId } = await seed("Verified");
    openOnChain(contractId, findingId);
    const res = await app.inject({
      method: "POST",
      url: `/api/findings/${findingId}/dispute`,
      headers: { cookie: await signIn(app, AUDITOR) },
      payload: { reason: "x" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("lists disputes for the arbiter only, and rules once the chain has ruled", async () => {
    const { app, seed, openOnChain, store, chainActions } = setup();
    const { contractId, findingId } = await seed("Verified");
    openOnChain(contractId, findingId);
    const dev = await signIn(app, DEVELOPER);
    const opened = await app.inject({
      method: "POST",
      url: `/api/findings/${findingId}/dispute`,
      headers: { cookie: dev },
      payload: { reason: "bad PoC" },
    });
    const disputeId = opened.json().id as string;

    expect(
      (await app.inject({ method: "GET", url: "/api/arbiter/disputes", headers: { cookie: dev } }))
        .statusCode,
    ).toBe(403);
    const arbiter = await signIn(app, ARBITER);
    const list = await app.inject({
      method: "GET",
      url: "/api/arbiter/disputes?ruling=Pending",
      headers: { cookie: arbiter },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toHaveLength(1);
    expect(list.json()[0]).toMatchObject({ id: disputeId, finding: { id: findingId } });

    const rule = (ruling: string) =>
      app.inject({
        method: "POST",
        url: `/api/arbiter/disputes/${disputeId}/rule`,
        headers: { cookie: arbiter },
        payload: { ruling },
      });
    expect((await rule("AgainstAuditor")).statusCode).toBe(409); // not ruled on-chain yet
    openOnChain(contractId, findingId, true); // ruled; escrow verification cleared → auditor lost
    expect((await rule("ForAuditor")).statusCode).toBe(409); // escrow says the auditor lost
    const ruled = await rule("AgainstAuditor");
    expect(ruled.statusCode).toBe(200);
    expect(ruled.json()).toMatchObject({ ruling: "AgainstAuditor", arbiterId: ARBITER.address });
    expect(store.findings.get(findingId)?.status).toBe("Rejected");
    expect(chainActions.applyDisputeResolved).toHaveBeenCalledWith(findingId);
    expect((await rule("AgainstAuditor")).statusCode).toBe(200); // repeating the recorded outcome is idempotent
    expect((await rule("ForAuditor")).statusCode).toBe(409); // contradicts the recorded ruling
  });

  it("accepts the arbiter's ruling when the indexer already recorded the same outcome", async () => {
    const { app, seed, openOnChain, disputes, chainActions } = setup();
    const { contractId, findingId } = await seed("Verified");
    openOnChain(contractId, findingId);
    const dev = await signIn(app, DEVELOPER);
    const opened = await app.inject({
      method: "POST",
      url: `/api/findings/${findingId}/dispute`,
      headers: { cookie: dev },
      payload: { reason: "bad PoC" },
    });
    const disputeId = opened.json().id as string;
    openOnChain(contractId, findingId, true);
    // The indexer saw Unfrozen(auditorWon = false) before the arbiter's API call.
    await disputes.setRuling(disputeId, "AgainstAuditor", "0xindexer", new Date());

    const arbiter = await signIn(app, ARBITER);
    const ruled = await app.inject({
      method: "POST",
      url: `/api/arbiter/disputes/${disputeId}/rule`,
      headers: { cookie: arbiter },
      payload: { ruling: "AgainstAuditor" },
    });
    expect(ruled.statusCode).toBe(200);
    expect(ruled.json()).toMatchObject({ id: disputeId, ruling: "AgainstAuditor" });
    // The API still retries the stake unlock, in case the indexer's attempt failed.
    expect(chainActions.applyDisputeResolved).toHaveBeenCalledWith(findingId);
  });

  it("a ruling for the auditor returns the finding to Verified with a new window", async () => {
    const { app, seed, openOnChain, store, setVerified } = setup();
    const { contractId, findingId } = await seed("Verified");
    openOnChain(contractId, findingId);
    const opened = await app.inject({
      method: "POST",
      url: `/api/findings/${findingId}/dispute`,
      headers: { cookie: await signIn(app, DEVELOPER) },
      payload: { reason: "bad PoC" },
    });
    openOnChain(contractId, findingId, true);
    setVerified(findingId);
    const res = await app.inject({
      method: "POST",
      url: `/api/arbiter/disputes/${opened.json().id}/rule`,
      headers: { cookie: await signIn(app, ARBITER) },
      payload: { ruling: "ForAuditor" },
    });
    expect(res.statusCode).toBe(200);
    expect(store.findings.get(findingId)?.status).toBe("Verified");
  });

  it("a ruling for the auditor keeps the stake lock until the payout", async () => {
    // The finding still awaits its payout, which reverts AuditorNotEligible if
    // the auditor withdrew in between.
    const { app, seed, openOnChain, setVerified, chainActions } = setup();
    const { contractId, findingId } = await seed("Verified");
    openOnChain(contractId, findingId);
    const opened = await app.inject({
      method: "POST",
      url: `/api/findings/${findingId}/dispute`,
      headers: { cookie: await signIn(app, DEVELOPER) },
      payload: { reason: "bad PoC" },
    });
    openOnChain(contractId, findingId, true);
    setVerified(findingId);
    const arbiter = await signIn(app, ARBITER);
    const rule = () =>
      app.inject({
        method: "POST",
        url: `/api/arbiter/disputes/${opened.json().id}/rule`,
        headers: { cookie: arbiter },
        payload: { ruling: "ForAuditor" },
      });
    expect((await rule()).statusCode).toBe(200);
    expect((await rule()).statusCode).toBe(200); // the idempotent repeat must not unlock either
    expect(chainActions.applyDisputeResolved).not.toHaveBeenCalled();
  });
});

describe("finding lifecycle route edge cases", () => {
  /** Opens a dispute through the route and returns its id. */
  async function openDispute(ctx: ReturnType<typeof setup>) {
    const { contractId, findingId } = await ctx.seed("Verified");
    ctx.openOnChain(contractId, findingId);
    const opened = await ctx.app.inject({
      method: "POST",
      url: `/api/findings/${findingId}/dispute`,
      headers: { cookie: await signIn(ctx.app, DEVELOPER) },
      payload: { reason: "bad PoC" },
    });
    expect(opened.statusCode).toBe(201);
    return { contractId, findingId, disputeId: opened.json().id as string };
  }

  it("GET /api/auditor/profile is 401 without a session", async () => {
    const { app } = setup();
    const res = await app.inject({ method: "GET", url: "/api/auditor/profile" });
    expect(res.statusCode).toBe(401);
  });

  it("POST /api/findings/:id/false-positive is 404 for an unknown finding", async () => {
    const { app } = setup();
    const res = await app.inject({
      method: "POST",
      url: "/api/findings/finding_missing/false-positive",
      headers: { cookie: await signIn(app, AUDITOR) },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "Finding not found" });
  });

  it.each([
    ["no body", undefined],
    ["missing reason", {}],
    ["blank reason", { reason: "   " }],
    ["non-string reason", { reason: 42 }],
  ])("POST /api/findings/:id/dispute is 400 with %s", async (_label, payload) => {
    const { app, seed, openOnChain, store } = setup();
    const { contractId, findingId } = await seed("Verified");
    openOnChain(contractId, findingId);
    const res = await app.inject({
      method: "POST",
      url: `/api/findings/${findingId}/dispute`,
      headers: { cookie: await signIn(app, DEVELOPER) },
      ...(payload !== undefined ? { payload } : {}),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "reason is required" });
    expect(store.findings.get(findingId)?.status).toBe("Verified");
  });

  it("POST /api/findings/:id/dispute is 404 for an unknown finding", async () => {
    const { app } = setup();
    const res = await app.inject({
      method: "POST",
      url: "/api/findings/finding_missing/dispute",
      headers: { cookie: await signIn(app, DEVELOPER) },
      payload: { reason: "bad PoC" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "Finding not found" });
  });

  it("GET /api/arbiter/disputes filters by ForAuditor / AgainstAuditor and ignores an invalid ruling", async () => {
    const ctx = setup();
    const { app, disputes } = ctx;
    const pending = await openDispute(ctx);
    const forAuditor = await openDispute(ctx);
    const against = await openDispute(ctx);
    await disputes.setRuling(forAuditor.disputeId, "ForAuditor", ARBITER.address, T0);
    await disputes.setRuling(against.disputeId, "AgainstAuditor", ARBITER.address, T0);

    const cookie = await signIn(app, ARBITER);
    const ids = async (query: string) => {
      const res = await app.inject({
        method: "GET",
        url: `/api/arbiter/disputes${query}`,
        headers: { cookie },
      });
      expect(res.statusCode).toBe(200);
      return (res.json() as Array<{ id: string }>).map((d) => d.id).sort();
    };

    expect(await ids("?ruling=ForAuditor")).toEqual([forAuditor.disputeId]);
    expect(await ids("?ruling=AgainstAuditor")).toEqual([against.disputeId]);
    expect(await ids("?ruling=Pending")).toEqual([pending.disputeId]);
    const all = [pending.disputeId, forAuditor.disputeId, against.disputeId].sort();
    // An unknown ruling falls back to no filter, as does no query at all.
    expect(await ids("?ruling=Bogus")).toEqual(all);
    expect(await ids("")).toEqual(all);
  });

  it("GET /api/arbiter/disputes is 401 without a session", async () => {
    const { app } = setup();
    const res = await app.inject({ method: "GET", url: "/api/arbiter/disputes" });
    expect(res.statusCode).toBe(401);
  });

  it.each([["Pending"], ["Bogus"], [""], [undefined]])(
    "POST /api/arbiter/disputes/:id/rule is 400 for ruling %s",
    async (ruling) => {
      const ctx = setup();
      const { disputeId } = await openDispute(ctx);
      const res = await ctx.app.inject({
        method: "POST",
        url: `/api/arbiter/disputes/${disputeId}/rule`,
        headers: { cookie: await signIn(ctx.app, ARBITER) },
        payload: ruling === undefined ? {} : { ruling },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: "ruling must be ForAuditor or AgainstAuditor" });
    },
  );

  it("POST /api/arbiter/disputes/:id/rule is 403 for a non-arbiter", async () => {
    const ctx = setup();
    const { disputeId } = await openDispute(ctx);
    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/arbiter/disputes/${disputeId}/rule`,
      headers: { cookie: await signIn(ctx.app, DEVELOPER) },
      payload: { ruling: "ForAuditor" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("POST /api/arbiter/disputes/:id/rule is 404 for an unknown dispute", async () => {
    const { app } = setup();
    const res = await app.inject({
      method: "POST",
      url: "/api/arbiter/disputes/dispute_missing/rule",
      headers: { cookie: await signIn(app, ARBITER) },
      payload: { ruling: "ForAuditor" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "Dispute not found" });
  });

  it("POST /api/arbiter/disputes/:id/rule is 404 when the dispute's finding is gone", async () => {
    const { app, disputes } = setup();
    await disputes.create({
      id: "dispute_orphan",
      findingId: "finding_gone",
      contractId: "contract_gone",
      developerId: DEVELOPER.address,
      reason: "orphaned",
      openedAt: T0.toISOString(),
      challengeWindowExpiresAt: T0.toISOString(),
      ruling: "Pending",
      ruledAt: null,
      arbiterId: null,
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/arbiter/disputes/dispute_orphan/rule",
      headers: { cookie: await signIn(app, ARBITER) },
      payload: { ruling: "AgainstAuditor" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "Finding not found" });
  });

  it("POST /api/arbiter/disputes/:id/rule is 409 when the dispute was already ruled the other way", async () => {
    const ctx = setup();
    const { disputeId, findingId } = await openDispute(ctx);
    await ctx.disputes.setRuling(disputeId, "ForAuditor", ARBITER.address, T0);
    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/arbiter/disputes/${disputeId}/rule`,
      headers: { cookie: await signIn(ctx.app, ARBITER) },
      payload: { ruling: "AgainstAuditor" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "Dispute already ruled" });
    expect(ctx.store.findings.get(findingId)?.status).toBe("Disputed");
    expect(ctx.chainActions.applyDisputeResolved).not.toHaveBeenCalled();
  });

  it("a failing claim-lock release does not fail an AgainstAuditor ruling", async () => {
    const ctx = setup();
    const { contractId, findingId, disputeId } = await openDispute(ctx);
    ctx.openOnChain(contractId, findingId, true);
    ctx.chainActions.applyDisputeResolved.mockRejectedValueOnce(new Error("rpc down"));
    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/arbiter/disputes/${disputeId}/rule`,
      headers: { cookie: await signIn(ctx.app, ARBITER) },
      payload: { ruling: "AgainstAuditor" },
    });
    expect(res.statusCode).toBe(200);
    expect(ctx.store.findings.get(findingId)?.status).toBe("Rejected");
  });
});
