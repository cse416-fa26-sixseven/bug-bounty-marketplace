import { describe, expect, it, vi } from "vitest";
import type { Address, Hash, Hex } from "viem";
import type { FindingStatus, SandboxStatus } from "@bbm/shared";
import { MemoryContractRepository } from "../contracts/memory-repository.js";
import { MemoryPipelineRepository, MemoryStore } from "../pipeline/memory-repository.js";
import { makeContract, makeFinding } from "../testing/repository-suite.js";
import { VerdictDeferredError, createChainActions, type ChainActions } from "./actions.js";
import type { BountyEscrowPort, OnchainBounty } from "./bounty-escrow.js";
import { MemoryChainActionStore } from "./memory-action-store.js";
import { runVerdictsOnce } from "./verdict-loop.js";

const AUDITOR = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
const HASH = `0x${"ab".repeat(32)}` as Hash;
const ZERO = `0x${"0".repeat(64)}` as Hex;
const T0 = "2026-10-20T12:00:00.000Z";

function setup() {
  const store = new MemoryStore();
  const contracts = new MemoryContractRepository(store);
  const pipeline = new MemoryPipelineRepository(store);
  let n = 0;
  async function seed(sandbox: SandboxStatus, findingStatus: FindingStatus = "Submitted") {
    const record = makeContract();
    await contracts.insertContract(record);
    const finding = makeFinding(record.contract.id, {
      status: findingStatus,
      statusHistory: [{ status: findingStatus, changedAt: T0 }],
    });
    store.findings.set(finding.id, finding);
    n += 1;
    const pocId = `poc_${n}`;
    store.pocs.set(pocId, {
      id: pocId,
      findingId: finding.id,
      auditorId: AUDITOR,
      testFileReference: `pocs/${pocId}/x.t.sol`,
      submittedAt: new Date(Date.parse(T0) + n * 1000).toISOString(),
      sandboxStatus: sandbox,
      sandboxLog: null,
    });
    return { pocId, findingId: finding.id };
  }
  return { store, pipeline, seed };
}

function fakeActions(): ChainActions & { applyVerdict: ReturnType<typeof vi.fn> } {
  return {
    chainConfigured: true,
    lockClaim: vi.fn(),
    releaseExpiredLocks: vi.fn(),
    finishPendingUnlocks: vi.fn(),
    applyVerdict: vi.fn(async () => "Verified" as FindingStatus),
    applyDisputeResolved: vi.fn(),
    runPayoutsOnce: vi.fn(),
  } as unknown as ChainActions & { applyVerdict: ReturnType<typeof vi.fn> };
}

describe("runVerdictsOnce", () => {
  it("applies a Passed verdict through chain actions and marks it applied", async () => {
    const { pipeline, seed } = setup();
    const { pocId, findingId } = await seed("Passed");
    const chainActions = fakeActions();

    const summary = await runVerdictsOnce({ pipeline, chainActions });

    expect(summary).toEqual({ applied: 1, failed: 0, deferred: 0 });
    expect(chainActions.applyVerdict).toHaveBeenCalledWith(findingId, "Passed");
    expect(await pipeline.listUnappliedVerdicts(10)).toEqual([]);
    expect(pocId).toBeDefined();
  });

  it("leaves a failing verdict unmarked and continues with the next", async () => {
    const { pipeline, seed } = setup();
    const first = await seed("Failed");
    const second = await seed("Passed");
    const chainActions = fakeActions();
    chainActions.applyVerdict.mockImplementationOnce(async () => {
      throw new Error("rpc down");
    });

    const summary = await runVerdictsOnce({ pipeline, chainActions, onError: () => {} });

    expect(summary).toEqual({ applied: 1, failed: 1, deferred: 0 });
    expect(await pipeline.listUnappliedVerdicts(10)).toEqual([
      { pocId: first.pocId, findingId: first.findingId, verdict: "Failed" },
    ]);
    expect(second.pocId).toBeDefined();
  });

  it("leaves a deferred verdict unmarked without reporting an error, and applies it on a later pass", async () => {
    const { pipeline, seed } = setup();
    const { pocId, findingId } = await seed("Passed");
    const chainActions = fakeActions();
    chainActions.applyVerdict.mockImplementationOnce(async () => {
      throw new VerdictDeferredError(findingId, `0x${"cd".repeat(32)}`);
    });
    const onError = vi.fn();

    const first = await runVerdictsOnce({ pipeline, chainActions, onError });

    expect(first).toEqual({ applied: 0, failed: 0, deferred: 1 });
    expect(onError).not.toHaveBeenCalled();
    expect(await pipeline.listUnappliedVerdicts(10)).toEqual([{ pocId, findingId, verdict: "Passed" }]);

    const second = await runVerdictsOnce({ pipeline, chainActions, onError });

    expect(second).toEqual({ applied: 1, failed: 0, deferred: 0 });
    expect(onError).not.toHaveBeenCalled();
    expect(await pipeline.listUnappliedVerdicts(10)).toEqual([]);
  });

  it("does not list Pending PoCs or findings that already moved", async () => {
    const { pipeline, seed } = setup();
    await seed("Pending");
    await seed("Passed", "Verified");
    expect(await pipeline.listUnappliedVerdicts(10)).toEqual([]);
  });

  it("converges without a second recordVerification when marking fails after the chain write", async () => {
    const { store, pipeline, seed } = setup();
    const { findingId } = await seed("Passed");
    let verified: Hex = ZERO;
    let submissions = 0n;
    const bountyEscrow = {
      recordSubmission: vi.fn(async () => {
        submissions += 1n;
        return HASH;
      }),
      recordVerification: vi.fn(async (_c: Hex, finding: Hex) => {
        verified = finding;
        return HASH;
      }),
      payout: vi.fn(async () => HASH),
      pendingPayouts: vi.fn(async () => 0n),
      readBounty: vi.fn(
        async (): Promise<OnchainBounty> => ({
          developer: AUDITOR,
          amount: 0n,
          deadline: 0n,
          state: 1,
          submissionCount: submissions,
          verifiedFinding: verified,
          verifiedAuditor: AUDITOR,
          frozen: false,
        }),
      ),
    } satisfies BountyEscrowPort;
    const chainActions = createChainActions({
      store: new MemoryChainActionStore(store),
      bountyEscrow,
      claimLockEnabled: false,
      onError: () => {},
    });
    const markVerdictApplied = pipeline.markVerdictApplied.bind(pipeline);
    const flaky = vi
      .spyOn(pipeline, "markVerdictApplied")
      .mockImplementationOnce(async () => {
        throw new Error("db blip");
      })
      .mockImplementation(markVerdictApplied);

    const first = await runVerdictsOnce({ pipeline, chainActions, onError: () => {} });
    const second = await runVerdictsOnce({ pipeline, chainActions, onError: () => {} });

    // The finding already moved, so nothing is left to apply: no second send.
    expect(first).toEqual({ applied: 0, failed: 1, deferred: 0 });
    expect(second).toEqual({ applied: 0, failed: 0, deferred: 0 });
    expect(bountyEscrow.recordVerification).toHaveBeenCalledTimes(1);
    expect(store.findings.get(findingId)?.status).toBe("Verified");
    expect(flaky).toHaveBeenCalledTimes(1);
  });

  it("retries without a second recordVerification when the status write fails after the chain write", async () => {
    const { store, pipeline, seed } = setup();
    const { findingId } = await seed("Passed");
    let verified: Hex = ZERO;
    let submissions = 0n;
    const bountyEscrow = {
      recordSubmission: vi.fn(async () => {
        submissions += 1n;
        return HASH;
      }),
      recordVerification: vi.fn(async (_c: Hex, finding: Hex) => {
        verified = finding;
        return HASH;
      }),
      payout: vi.fn(async () => HASH),
      pendingPayouts: vi.fn(async () => 0n),
      readBounty: vi.fn(
        async (): Promise<OnchainBounty> => ({
          developer: AUDITOR,
          amount: 0n,
          deadline: 0n,
          state: 1,
          submissionCount: submissions,
          verifiedFinding: verified,
          verifiedAuditor: AUDITOR,
          frozen: false,
        }),
      ),
    } satisfies BountyEscrowPort;
    const chainStore = new MemoryChainActionStore(store);
    const setStatus = chainStore.setFindingStatus.bind(chainStore);
    vi.spyOn(chainStore, "setFindingStatus")
      .mockImplementationOnce(async () => {
        throw new Error("db blip");
      })
      .mockImplementation(setStatus);
    const chainActions = createChainActions({
      store: chainStore,
      bountyEscrow,
      claimLockEnabled: false,
      onError: () => {},
    });

    const first = await runVerdictsOnce({ pipeline, chainActions, onError: () => {} });
    const second = await runVerdictsOnce({ pipeline, chainActions, onError: () => {} });

    expect(first).toEqual({ applied: 0, failed: 1, deferred: 0 });
    expect(second).toEqual({ applied: 1, failed: 0, deferred: 0 });
    expect(bountyEscrow.recordVerification).toHaveBeenCalledTimes(1);
    expect(bountyEscrow.recordSubmission).toHaveBeenCalledTimes(1);
    expect(store.findings.get(findingId)?.status).toBe("Verified");
  });
});

describe("runVerdictsOnce racing the indexer", () => {
  it("succeeds when the indexer sets Verified while the chain write is in flight", async () => {
    const { store, pipeline, seed } = setup();
    const { findingId } = await seed("Passed");
    let verified: Hex = ZERO;
    let submissions = 0n;
    const chainStore = new MemoryChainActionStore(store);
    const bountyEscrow = {
      recordSubmission: vi.fn(async () => {
        submissions += 1n;
        return HASH;
      }),
      recordVerification: vi.fn(async (_c: Hex, finding: Hex) => {
        verified = finding;
        // The indexer applies FindingVerified before applyVerdict writes.
        await chainStore.setFindingStatus(findingId, "Verified", T0);
        return HASH;
      }),
      payout: vi.fn(async () => HASH),
      pendingPayouts: vi.fn(async () => 0n),
      readBounty: vi.fn(
        async (): Promise<OnchainBounty> => ({
          developer: AUDITOR,
          amount: 0n,
          deadline: 0n,
          state: 1,
          submissionCount: submissions,
          verifiedFinding: verified,
          verifiedAuditor: AUDITOR,
          frozen: false,
        }),
      ),
    } satisfies BountyEscrowPort;
    const chainActions = createChainActions({ store: chainStore, bountyEscrow, claimLockEnabled: false, onError: () => {} });

    expect(await runVerdictsOnce({ pipeline, chainActions, onError: () => {} })).toEqual({ applied: 1, failed: 0, deferred: 0 });
    expect(store.findings.get(findingId)?.statusHistory.filter((h) => h.status === "Verified")).toHaveLength(1);
  });
});
