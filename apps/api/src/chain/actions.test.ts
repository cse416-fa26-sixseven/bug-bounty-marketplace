import { describe, expect, it, vi } from "vitest";
import type { Address, Hash, Hex } from "viem";
import type { FindingStatus, PoCSubmission } from "@bbm/shared";
import { MemoryContractRepository } from "../contracts/memory-repository.js";
import { MemoryStore } from "../pipeline/memory-repository.js";
import { makeContract, makeFinding } from "../testing/repository-suite.js";
import { VerdictDeferredError, createChainActions, type ChainActionsDeps } from "./actions.js";
import type { AuditorStakingPort } from "./auditor-staking.js";
import type { BountyEscrowPort, OnchainBounty } from "./bounty-escrow.js";
import { onchainId } from "./ids.js";
import { MemoryChainActionStore } from "./memory-action-store.js";
import { InvalidTransitionError } from "../status/transitions.js";

const T0 = new Date("2026-10-20T12:00:00.000Z");
const CLAIM_WINDOW_MS = 600_000;
const AUDITOR = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
const HASH = `0x${"ab".repeat(32)}` as Hash;
const ZERO_HASH = `0x${"0".repeat(64)}` as Hex;

/** Fake ports: plain mocks, no RPC. AuditorStaking keeps a lock counter the way
 * the contract does. BountyEscrow reads report an open, unverified bounty
 * unless a test installs state with `statefulBounty`. */
function fakePorts() {
  const bountyEscrow = {
    recordSubmission: vi.fn(async (_contract: Hex) => HASH),
    recordVerification: vi.fn(async (_contract: Hex, _finding: Hex, _auditor: Address) => HASH),
    payout: vi.fn(async (_contract: Hex, _finding: Hex, _auditor: Address) => HASH),
    pendingPayouts: vi.fn(async () => 0n),
    readBounty: vi.fn(
      async (_contract: Hex): Promise<OnchainBounty> => ({
        developer: AUDITOR,
        amount: 0n,
        deadline: 0n,
        state: 1,
        submissionCount: 0n,
        verifiedFinding: ZERO_HASH,
        verifiedAuditor: AUDITOR,
        frozen: false,
      }),
    ),
  } satisfies BountyEscrowPort & Record<string, unknown>;
  let active = 0n;
  const auditorStaking = {
    stakeOf: vi.fn(async () => 0n),
    reputation: vi.fn(async () => 0n),
    activeSubmissions: vi.fn(async () => active),
    lockSubmission: vi.fn(async (_auditor: Address) => {
      active += 1n;
      return HASH;
    }),
    unlockSubmission: vi.fn(async (_auditor: Address) => {
      if (active === 0n) throw new Error("NoActiveSubmission");
      active -= 1n;
      return HASH;
    }),
  } satisfies AuditorStakingPort & Record<string, unknown>;
  return { bountyEscrow, auditorStaking };
}

/** Makes the BountyEscrow fake keep state, so writes change what reads return,
 * as the contract does. A payout marks the bounty Paid for its finding. Like
 * the contract, recordVerification reverts while another finding is verified.
 * Returns controls for the chain changes no operator call makes. */
function statefulBounty(ports: ReturnType<typeof fakePorts>) {
  let submissions = 0n;
  let verified: Hex = ZERO_HASH;
  let paid = false;
  let closed = false;
  ports.bountyEscrow.recordSubmission.mockImplementation(async () => {
    submissions += 1n;
    return HASH;
  });
  ports.bountyEscrow.recordVerification.mockImplementation(async (_c, finding) => {
    if (paid || closed) throw new Error("BountyNotOpen()");
    if (verified !== ZERO_HASH) throw new Error("AlreadyVerified()");
    verified = finding;
    return HASH;
  });
  ports.bountyEscrow.payout.mockImplementation(async (_c, finding) => {
    verified = finding;
    paid = true;
    return HASH;
  });
  ports.bountyEscrow.readBounty.mockImplementation(async () => ({
    developer: AUDITOR,
    amount: 0n,
    deadline: 0n,
    state: paid ? 2 : closed ? 3 : 1,
    submissionCount: submissions,
    verifiedFinding: verified,
    verifiedAuditor: AUDITOR,
    frozen: false,
  }));
  return {
    /** unfreeze(..., auditorWon=false): a lost dispute clears the verification. */
    clearVerification() {
      verified = ZERO_HASH;
    },
    /** The developer refunded (or deleted) the bounty: it is Closed. */
    close() {
      closed = true;
    },
  };
}

function setup(options: { lockEnabled?: boolean; withChain?: boolean } = {}) {
  const store = new MemoryStore();
  const repository = new MemoryContractRepository(store);
  const chainStore = new MemoryChainActionStore(store);
  const clock = { now: T0 };
  const ports = fakePorts();
  const withChain = options.withChain ?? true;
  const deps: ChainActionsDeps = {
    store: chainStore,
    bountyEscrow: withChain ? ports.bountyEscrow : undefined,
    auditorStaking: withChain ? ports.auditorStaking : undefined,
    claimLockEnabled: options.lockEnabled ?? true,
    now: () => clock.now,
    onError: () => {},
  };
  const actions = createChainActions(deps);

  let pocCount = 0;
  /** Seeds a finding with a PoC by `auditor`. Status is set directly, so the
   * test controls the starting point. */
  function seedFinding(
    contractId: string,
    status: FindingStatus,
    overrides: Partial<{ challengeWindowExpiresAt: string | null; sandboxStatus: PoCSubmission["sandboxStatus"] }> = {},
  ) {
    const finding = makeFinding(contractId, {
      status,
      statusHistory: [{ status, changedAt: T0.toISOString() }],
      challengeWindowExpiresAt: overrides.challengeWindowExpiresAt ?? null,
    });
    store.findings.set(finding.id, finding);
    pocCount += 1;
    const poc: PoCSubmission = {
      id: `poc_${pocCount}`,
      findingId: finding.id,
      auditorId: AUDITOR,
      testFileReference: `pocs/poc_${pocCount}/x.t.sol`,
      submittedAt: T0.toISOString(),
      sandboxStatus: overrides.sandboxStatus ?? "Pending",
      sandboxLog: null,
    };
    store.pocs.set(poc.id, poc);
    return finding.id;
  }

  async function seedContract() {
    const record = makeContract();
    await repository.insertContract(record);
    return record.contract.id;
  }

  /** Claims the contract as `auditor` and, unless `lock` is false, runs the
   * same lock step the claim route runs. */
  async function claim(contractId: string, auditor: Address = AUDITOR, lock = true) {
    const expiresAt = new Date(clock.now.getTime() + CLAIM_WINDOW_MS);
    const result = await repository.claimContract(contractId, auditor, expiresAt, clock.now);
    if (!result.ok) throw new Error("claim failed in test setup");
    if (lock) await actions.lockClaim(contractId, auditor);
  }

  function advance(ms: number) {
    clock.now = new Date(clock.now.getTime() + ms);
  }

  return { store, chainStore, repository, clock, actions, ports, seedFinding, seedContract, claim, advance };
}

describe("applyVerdict with Passed", () => {
  it("records the submission and the verification, then marks the finding Verified", async () => {
    const { actions, ports, seedFinding, seedContract, claim, store } = setup();
    const contractId = await seedContract();
    const findingId = seedFinding(contractId, "Submitted");
    await claim(contractId);

    const status = await actions.applyVerdict(findingId, "Passed");

    expect(status).toBe("Verified");
    expect(store.findings.get(findingId)?.status).toBe("Verified");
    expect(ports.bountyEscrow.recordSubmission).toHaveBeenCalledWith(onchainId(contractId));
    expect(ports.bountyEscrow.recordVerification).toHaveBeenCalledWith(
      onchainId(contractId),
      onchainId(findingId),
      AUDITOR,
    );
    // The submission is recorded before the verification.
    const submissionOrder = ports.bountyEscrow.recordSubmission.mock.invocationCallOrder[0]!;
    const verificationOrder = ports.bountyEscrow.recordVerification.mock.invocationCallOrder[0]!;
    expect(submissionOrder).toBeLessThan(verificationOrder);
  });

  it("records the submission once per contract, but each verification", async () => {
    const { actions, ports, seedFinding, seedContract, claim } = setup();
    const contractId = await seedContract();
    const first = seedFinding(contractId, "Submitted");
    const second = seedFinding(contractId, "Submitted");
    await claim(contractId);

    await actions.applyVerdict(first, "Passed");
    await actions.applyVerdict(second, "Passed");

    expect(ports.bountyEscrow.recordSubmission).toHaveBeenCalledTimes(1);
    expect(ports.bountyEscrow.recordVerification).toHaveBeenCalledTimes(2);
  });

  it("leaves the status unchanged when the chain call fails, and a retry completes", async () => {
    const { actions, ports, seedFinding, seedContract, claim, store } = setup();
    const contractId = await seedContract();
    const findingId = seedFinding(contractId, "Submitted");
    await claim(contractId);
    ports.bountyEscrow.recordVerification.mockRejectedValueOnce(new Error("rpc unavailable"));

    await expect(actions.applyVerdict(findingId, "Passed")).rejects.toThrow("rpc unavailable");
    expect(store.findings.get(findingId)?.status).toBe("Submitted");

    await expect(actions.applyVerdict(findingId, "Passed")).resolves.toBe("Verified");
    expect(store.findings.get(findingId)?.status).toBe("Verified");
    // The submission was confirmed on the first attempt, so the retry skips it.
    expect(ports.bountyEscrow.recordSubmission).toHaveBeenCalledTimes(1);
  });

  it("rejects an illegal move before any chain call", async () => {
    const { actions, ports, seedFinding, seedContract, store } = setup();
    const contractId = await seedContract();
    const findingId = seedFinding(contractId, "Flagged");

    await expect(actions.applyVerdict(findingId, "Passed")).rejects.toBeInstanceOf(
      InvalidTransitionError,
    );
    expect(ports.bountyEscrow.recordSubmission).not.toHaveBeenCalled();
    expect(ports.bountyEscrow.recordVerification).not.toHaveBeenCalled();
    expect(store.findings.get(findingId)?.status).toBe("Flagged");
  });

  it("does nothing when the finding is already Verified", async () => {
    const { actions, ports, seedFinding, seedContract } = setup();
    const contractId = await seedContract();
    const findingId = seedFinding(contractId, "Verified");

    await expect(actions.applyVerdict(findingId, "Passed")).resolves.toBe("Verified");
    expect(ports.bountyEscrow.recordVerification).not.toHaveBeenCalled();
  });
});

describe("applyVerdict with Passed on a bounty that verified another finding", () => {
  it("rejects the finding without a send once the bounty is Paid for another finding, and releases the lock", async () => {
    const { actions, ports, seedFinding, seedContract, claim, store } = setup();
    statefulBounty(ports);
    const contractId = await seedContract();
    const first = seedFinding(contractId, "Submitted");
    const second = seedFinding(contractId, "Submitted");
    await claim(contractId);
    await expect(actions.applyVerdict(first, "Passed")).resolves.toBe("Verified");
    await ports.bountyEscrow.payout(onchainId(contractId), onchainId(first), AUDITOR);
    store.findings.get(first)!.status = "Paid";
    ports.bountyEscrow.recordSubmission.mockClear();
    ports.bountyEscrow.recordVerification.mockClear();

    await expect(actions.applyVerdict(second, "Passed")).resolves.toBe("Rejected");
    expect(store.findings.get(second)?.status).toBe("Rejected");
    expect(ports.bountyEscrow.recordSubmission).not.toHaveBeenCalled();
    expect(ports.bountyEscrow.recordVerification).not.toHaveBeenCalled();
    // The Failed branch's release: nothing else of the auditor's is pending.
    expect(ports.auditorStaking.unlockSubmission).toHaveBeenCalledTimes(1);
    expect(await ports.auditorStaking.activeSubmissions()).toBe(0n);
  });

  it("rejects the finding without a send once the bounty is Closed (refunded)", async () => {
    const { actions, ports, seedFinding, seedContract, claim, store } = setup();
    const bounty = statefulBounty(ports);
    const contractId = await seedContract();
    const findingId = seedFinding(contractId, "Submitted");
    await claim(contractId);
    bounty.close();

    await expect(actions.applyVerdict(findingId, "Passed")).resolves.toBe("Rejected");
    expect(store.findings.get(findingId)?.status).toBe("Rejected");
    expect(ports.bountyEscrow.recordSubmission).not.toHaveBeenCalled();
    expect(ports.bountyEscrow.recordVerification).not.toHaveBeenCalled();
    expect(ports.auditorStaking.unlockSubmission).toHaveBeenCalledTimes(1);
  });

  it("defers the verdict without a send while another finding is verified on the open bounty", async () => {
    const { actions, ports, seedFinding, seedContract, claim, store } = setup();
    statefulBounty(ports);
    const contractId = await seedContract();
    const first = seedFinding(contractId, "Submitted");
    const second = seedFinding(contractId, "Submitted");
    await claim(contractId);
    await expect(actions.applyVerdict(first, "Passed")).resolves.toBe("Verified");

    await expect(actions.applyVerdict(second, "Passed")).rejects.toBeInstanceOf(VerdictDeferredError);
    await expect(actions.applyVerdict(second, "Passed")).rejects.toBeInstanceOf(VerdictDeferredError);
    expect(ports.bountyEscrow.recordVerification).toHaveBeenCalledTimes(1);
    expect(store.findings.get(second)?.status).toBe("Submitted");
    expect(ports.auditorStaking.unlockSubmission).not.toHaveBeenCalled();
  });

  it("applies a deferred verdict once the other finding's verification is cleared", async () => {
    const { actions, ports, seedFinding, seedContract, claim, store } = setup();
    const bounty = statefulBounty(ports);
    const contractId = await seedContract();
    const first = seedFinding(contractId, "Submitted");
    const second = seedFinding(contractId, "Submitted");
    await claim(contractId);
    await actions.applyVerdict(first, "Passed");
    await expect(actions.applyVerdict(second, "Passed")).rejects.toBeInstanceOf(VerdictDeferredError);

    // The first finding lost its dispute: unfreeze cleared the verification.
    bounty.clearVerification();
    store.findings.get(first)!.status = "Rejected";

    await expect(actions.applyVerdict(second, "Passed")).resolves.toBe("Verified");
    expect(ports.bountyEscrow.recordVerification).toHaveBeenLastCalledWith(
      onchainId(contractId),
      onchainId(second),
      AUDITOR,
    );
    expect(ports.bountyEscrow.recordSubmission).toHaveBeenCalledTimes(1);
  });

  it("still marks the finding Verified when the bounty was Paid for this finding", async () => {
    const { actions, ports, seedFinding, seedContract, claim, store, chainStore } = setup();
    statefulBounty(ports);
    const contractId = await seedContract();
    const findingId = seedFinding(contractId, "Submitted");
    await claim(contractId);
    await ports.bountyEscrow.recordSubmission(onchainId(contractId));
    await ports.bountyEscrow.payout(onchainId(contractId), onchainId(findingId), AUDITOR);
    ports.bountyEscrow.recordVerification.mockClear();

    await expect(actions.applyVerdict(findingId, "Passed")).resolves.toBe("Verified");
    expect(store.findings.get(findingId)?.status).toBe("Verified");
    expect(ports.bountyEscrow.recordVerification).not.toHaveBeenCalled();
    expect((await chainStore.findFinding(findingId))?.verificationRecorded).toBe(true);
  });
});

describe("applyVerdict with Failed", () => {
  it("unlocks the auditor once and moves the finding to Rejected", async () => {
    const { actions, ports, seedFinding, seedContract, claim, store, advance } = setup();
    const contractId = await seedContract();
    const findingId = seedFinding(contractId, "Submitted");
    await claim(contractId);
    ports.auditorStaking.unlockSubmission.mockClear();

    await expect(actions.applyVerdict(findingId, "Failed")).resolves.toBe("Rejected");
    expect(store.findings.get(findingId)?.status).toBe("Rejected");
    expect(ports.auditorStaking.unlockSubmission).toHaveBeenCalledTimes(1);
    expect(ports.auditorStaking.unlockSubmission).toHaveBeenCalledWith(AUDITOR);

    // A repeat verdict and a later expiry sweep must not unlock again.
    await actions.applyVerdict(findingId, "Failed");
    advance(CLAIM_WINDOW_MS + 1);
    await expect(actions.releaseExpiredLocks(new Date(T0.getTime() + CLAIM_WINDOW_MS + 1))).resolves.toBe(0);
    expect(ports.auditorStaking.unlockSubmission).toHaveBeenCalledTimes(1);
  });

  it("keeps the status when the unlock fails, and a retry unlocks exactly once", async () => {
    const { actions, ports, seedFinding, seedContract, claim, store } = setup();
    const contractId = await seedContract();
    const findingId = seedFinding(contractId, "Submitted");
    await claim(contractId);
    ports.auditorStaking.unlockSubmission.mockRejectedValueOnce(new Error("rpc unavailable"));

    await expect(actions.applyVerdict(findingId, "Failed")).rejects.toThrow("rpc unavailable");
    expect(store.findings.get(findingId)?.status).toBe("Submitted");

    await expect(actions.applyVerdict(findingId, "Failed")).resolves.toBe("Rejected");
    expect(ports.auditorStaking.unlockSubmission).toHaveBeenCalledTimes(2);
    await actions.applyVerdict(findingId, "Failed");
    expect(ports.auditorStaking.unlockSubmission).toHaveBeenCalledTimes(2);
  });

  it("keeps the lock while another finding of the auditor's on the contract awaits payout", async () => {
    // Unlocked here, the auditor could withdraw, the Verified finding's payout
    // would revert AuditorNotEligible on every run and the refund AlreadyVerified.
    const { actions, ports, seedFinding, seedContract, claim, store } = setup();
    const contractId = await seedContract();
    const verified = seedFinding(contractId, "Verified");
    const failing = seedFinding(contractId, "Submitted");
    await claim(contractId);

    await expect(actions.applyVerdict(failing, "Failed")).resolves.toBe("Rejected");
    expect(ports.auditorStaking.unlockSubmission).not.toHaveBeenCalled();
    expect(await ports.auditorStaking.activeSubmissions()).toBe(1n);

    // PayoutCredited on the Verified finding then releases it.
    store.findings.get(verified)!.status = "Paid";
    await expect(actions.applyDisputeResolved(verified)).resolves.toBe(true);
    expect(ports.auditorStaking.unlockSubmission).toHaveBeenCalledTimes(1);
  });
});

describe("claim lock expiry", () => {
  it("unlocks a lapsed claim once; a second run does not unlock again", async () => {
    const { actions, ports, seedContract, claim, advance } = setup();
    const contractId = await seedContract();
    await claim(contractId);
    advance(CLAIM_WINDOW_MS);

    await expect(actions.releaseExpiredLocks(new Date(T0.getTime() + CLAIM_WINDOW_MS))).resolves.toBe(1);
    await expect(actions.releaseExpiredLocks(new Date(T0.getTime() + CLAIM_WINDOW_MS))).resolves.toBe(0);
    expect(ports.auditorStaking.unlockSubmission).toHaveBeenCalledTimes(1);
    expect(ports.auditorStaking.unlockSubmission).toHaveBeenCalledWith(AUDITOR);
  });

  it("keeps the stake locked past expiry while the auditor's finding is pending", async () => {
    const { actions, ports, seedFinding, seedContract, claim, advance } = setup();
    const contractId = await seedContract();
    const findingId = seedFinding(contractId, "Submitted");
    await claim(contractId);
    advance(CLAIM_WINDOW_MS * 2);

    // Unlocked here, the auditor could withdraw and the payout would revert.
    await expect(actions.releaseExpiredLocks(new Date(T0.getTime() + CLAIM_WINDOW_MS * 2))).resolves.toBe(0);
    await expect(actions.applyVerdict(findingId, "Passed")).resolves.toBe("Verified");
    await expect(actions.releaseExpiredLocks(new Date(T0.getTime() + CLAIM_WINDOW_MS * 2))).resolves.toBe(0);
    expect(ports.auditorStaking.unlockSubmission).not.toHaveBeenCalled();
    expect(await ports.auditorStaking.activeSubmissions()).toBe(1n);
  });

  it("releases the kept lock once the pending finding is rejected", async () => {
    const { actions, ports, seedFinding, seedContract, claim, advance } = setup();
    const contractId = await seedContract();
    const findingId = seedFinding(contractId, "Submitted");
    await claim(contractId);
    advance(CLAIM_WINDOW_MS * 2);

    await expect(actions.releaseExpiredLocks(new Date(T0.getTime() + CLAIM_WINDOW_MS * 2))).resolves.toBe(0);
    await expect(actions.applyVerdict(findingId, "Failed")).resolves.toBe("Rejected");
    expect(ports.auditorStaking.unlockSubmission).toHaveBeenCalledTimes(1);
  });

  it("does not unlock a claim that has not expired", async () => {
    const { actions, ports, seedContract, claim } = setup();
    const contractId = await seedContract();
    await claim(contractId);

    await expect(actions.releaseExpiredLocks(T0)).resolves.toBe(0);
    expect(ports.auditorStaking.unlockSubmission).not.toHaveBeenCalled();
  });

  it("never unlocks a claim that was never locked", async () => {
    const { actions, ports, seedFinding, seedContract, claim, advance, store } = setup();
    const contractId = await seedContract();
    const findingId = seedFinding(contractId, "Submitted");
    await claim(contractId, AUDITOR, false);
    advance(CLAIM_WINDOW_MS);

    await expect(actions.releaseExpiredLocks(new Date(T0.getTime() + CLAIM_WINDOW_MS))).resolves.toBe(0);
    await actions.applyVerdict(findingId, "Failed");
    expect(store.findings.get(findingId)?.status).toBe("Rejected");
    expect(ports.auditorStaking.unlockSubmission).not.toHaveBeenCalled();
  });
});

describe("CLAIM_LOCK_ENABLED off", () => {
  it("skips lock and unlock, while verdicts still reach the chain", async () => {
    const { actions, ports, seedFinding, seedContract, claim, store } = setup({ lockEnabled: false });
    const contractId = await seedContract();
    const passing = seedFinding(contractId, "Submitted");
    const failing = seedFinding(contractId, "Submitted");
    await claim(contractId);
    expect(ports.auditorStaking.lockSubmission).not.toHaveBeenCalled();

    await actions.applyVerdict(passing, "Passed");
    expect(ports.bountyEscrow.recordVerification).toHaveBeenCalledTimes(1);
    expect(store.findings.get(passing)?.status).toBe("Verified");

    await actions.applyVerdict(failing, "Failed");
    expect(ports.auditorStaking.unlockSubmission).not.toHaveBeenCalled();
    expect(store.findings.get(failing)?.status).toBe("Rejected");
  });
});

describe("dispute resolution", () => {
  it("unlocks the claim lock once when the dispute goes against the auditor", async () => {
    const { actions, ports, seedFinding, seedContract, claim } = setup();
    const contractId = await seedContract();
    const findingId = seedFinding(contractId, "Rejected");
    await claim(contractId);

    await expect(actions.applyDisputeResolved(findingId)).resolves.toBe(true);
    expect(ports.auditorStaking.unlockSubmission).toHaveBeenCalledTimes(1);
    expect(ports.auditorStaking.unlockSubmission).toHaveBeenCalledWith(AUDITOR);

    await expect(actions.applyDisputeResolved(findingId)).resolves.toBe(false);
    expect(ports.auditorStaking.unlockSubmission).toHaveBeenCalledTimes(1);
  });

  it.each(["Verified", "Disputed"] as const)(
    "keeps the claim lock while the finding is %s: the payout still needs the stake",
    async (status) => {
      // Verified: the auditor won the dispute and the finding awaits payout.
      const { actions, ports, seedFinding, seedContract, claim } = setup();
      const contractId = await seedContract();
      const findingId = seedFinding(contractId, status);
      await claim(contractId);

      await expect(actions.applyDisputeResolved(findingId)).resolves.toBe(false);
      expect(ports.auditorStaking.unlockSubmission).not.toHaveBeenCalled();
      expect(await ports.auditorStaking.activeSubmissions()).toBe(1n);
    },
  );

  it("releases a won dispute's lock once the finding is paid", async () => {
    const { actions, ports, seedFinding, seedContract, claim, store } = setup();
    const contractId = await seedContract();
    const findingId = seedFinding(contractId, "Verified");
    await claim(contractId);
    await expect(actions.applyDisputeResolved(findingId)).resolves.toBe(false);

    store.findings.get(findingId)!.status = "Paid";
    await expect(actions.applyDisputeResolved(findingId)).resolves.toBe(true);
    expect(ports.auditorStaking.unlockSubmission).toHaveBeenCalledTimes(1);
  });

  it("a lost dispute keeps the lock while another finding of the auditor's on the contract is pending", async () => {
    const { actions, ports, seedFinding, seedContract, claim } = setup();
    const contractId = await seedContract();
    const lost = seedFinding(contractId, "Rejected");
    const pending = seedFinding(contractId, "Submitted");
    await claim(contractId);

    await expect(actions.applyDisputeResolved(lost)).resolves.toBe(false);
    expect(ports.auditorStaking.unlockSubmission).not.toHaveBeenCalled();
    // Once the other finding is settled too, the lock goes.
    await expect(actions.applyVerdict(pending, "Failed")).resolves.toBe("Rejected");
    expect(ports.auditorStaking.unlockSubmission).toHaveBeenCalledTimes(1);
  });

  it("a payout releases the lock even with another finding of the auditor's still Submitted", async () => {
    // The bounty is paid, so that finding can never be verified or paid.
    const { actions, ports, seedFinding, seedContract, claim } = setup();
    const contractId = await seedContract();
    const paid = seedFinding(contractId, "Paid");
    seedFinding(contractId, "Submitted");
    await claim(contractId);

    await expect(actions.applyDisputeResolved(paid)).resolves.toBe(true);
    expect(ports.auditorStaking.unlockSubmission).toHaveBeenCalledTimes(1);
  });

  it("does not unlock again after a Failed verdict already released the lock", async () => {
    const { actions, ports, seedFinding, seedContract, claim } = setup();
    const contractId = await seedContract();
    const findingId = seedFinding(contractId, "Submitted");
    await claim(contractId);
    await actions.applyVerdict(findingId, "Failed");

    await expect(actions.applyDisputeResolved(findingId)).resolves.toBe(false);
    expect(ports.auditorStaking.unlockSubmission).toHaveBeenCalledTimes(1);
  });
});

describe("runPayoutsOnce", () => {
  it("pays only findings past their window, once each, and leaves a failed payout for the next run", async () => {
    const { actions, ports, seedFinding, seedContract, store, chainStore, clock } = setup();
    const contractId = await seedContract();
    const now = clock.now;
    const past = new Date(now.getTime() - 3_600_000).toISOString();
    const future = new Date(now.getTime() + 3_600_000).toISOString();
    const due1 = seedFinding(contractId, "Verified", { challengeWindowExpiresAt: past, sandboxStatus: "Passed" });
    const due2 = seedFinding(contractId, "Verified", { challengeWindowExpiresAt: past, sandboxStatus: "Passed" });
    const notYet = seedFinding(contractId, "Verified", { challengeWindowExpiresAt: future, sandboxStatus: "Passed" });
    const revertsOnce = seedFinding(contractId, "Verified", { challengeWindowExpiresAt: past, sandboxStatus: "Passed" });
    let failuresLeft = new Set([onchainId(revertsOnce)]);
    ports.bountyEscrow.payout.mockImplementation(async (_c: Hex, finding: Hex) => {
      if (failuresLeft.has(finding)) {
        failuresLeft = new Set();
        throw new Error("execution reverted");
      }
      return HASH;
    });

    await expect(actions.runPayoutsOnce(now)).resolves.toEqual({ due: 3, paid: 2, failed: 1 });
    expect(ports.bountyEscrow.payout).toHaveBeenCalledTimes(3);
    expect(ports.bountyEscrow.payout).toHaveBeenCalledWith(onchainId(contractId), onchainId(due1), AUDITOR);
    expect(ports.bountyEscrow.payout).toHaveBeenCalledWith(onchainId(contractId), onchainId(due2), AUDITOR);

    // Idempotent: the paid findings are not paid again; the reverted one is retried.
    await expect(actions.runPayoutsOnce(now)).resolves.toEqual({ due: 1, paid: 1, failed: 0 });
    expect(ports.bountyEscrow.payout).toHaveBeenCalledTimes(4);
    expect(ports.bountyEscrow.payout).toHaveBeenLastCalledWith(onchainId(contractId), onchainId(revertsOnce), AUDITOR);
    await expect(actions.runPayoutsOnce(now)).resolves.toEqual({ due: 0, paid: 0, failed: 0 });
    expect(ports.bountyEscrow.payout).toHaveBeenCalledTimes(4);

    // The keeper never sets Paid itself, and never touches a finding still inside its window.
    expect(store.findings.get(due1)?.status).toBe("Verified");
    expect(store.findings.get(notYet)?.status).toBe("Verified");
    await expect(chainStore.listPayoutsDue(now)).resolves.toHaveLength(0);
  });
});

describe("retries after a chain send whose marker write failed", () => {
  it("does not resend recordVerification", async () => {
    const { actions, ports, seedFinding, seedContract, claim, store, chainStore } = setup();
    statefulBounty(ports);
    const contractId = await seedContract();
    const findingId = seedFinding(contractId, "Submitted");
    await claim(contractId);
    vi.spyOn(chainStore, "markVerificationRecorded").mockRejectedValueOnce(new Error("db write failed"));

    await expect(actions.applyVerdict(findingId, "Passed")).rejects.toThrow("db write failed");
    expect(ports.bountyEscrow.recordVerification).toHaveBeenCalledTimes(1);
    expect(store.findings.get(findingId)?.status).toBe("Submitted");

    await expect(actions.applyVerdict(findingId, "Passed")).resolves.toBe("Verified");
    expect(ports.bountyEscrow.recordVerification).toHaveBeenCalledTimes(1);
    expect(ports.bountyEscrow.recordSubmission).toHaveBeenCalledTimes(1);
  });

  it("does not resend recordSubmission", async () => {
    const { actions, ports, seedFinding, seedContract, claim, store, chainStore } = setup();
    statefulBounty(ports);
    const contractId = await seedContract();
    const findingId = seedFinding(contractId, "Submitted");
    await claim(contractId);
    vi.spyOn(chainStore, "markSubmissionRecorded").mockRejectedValueOnce(new Error("db write failed"));

    await expect(actions.applyVerdict(findingId, "Passed")).rejects.toThrow("db write failed");
    expect(ports.bountyEscrow.recordSubmission).toHaveBeenCalledTimes(1);

    await expect(actions.applyVerdict(findingId, "Passed")).resolves.toBe("Verified");
    expect(ports.bountyEscrow.recordSubmission).toHaveBeenCalledTimes(1);
    expect(ports.bountyEscrow.recordVerification).toHaveBeenCalledTimes(1);
    expect(store.findings.get(findingId)?.status).toBe("Verified");
  });

  it("does not resend payout", async () => {
    const { actions, ports, seedFinding, seedContract, chainStore, clock } = setup();
    statefulBounty(ports);
    const contractId = await seedContract();
    const past = new Date(clock.now.getTime() - 3_600_000).toISOString();
    seedFinding(contractId, "Verified", { challengeWindowExpiresAt: past, sandboxStatus: "Passed" });
    vi.spyOn(chainStore, "markPayoutSent").mockRejectedValueOnce(new Error("db write failed"));

    await expect(actions.runPayoutsOnce(clock.now)).rejects.toThrow("db write failed");
    expect(ports.bountyEscrow.payout).toHaveBeenCalledTimes(1);

    await expect(actions.runPayoutsOnce(clock.now)).resolves.toEqual({ due: 1, paid: 1, failed: 0 });
    expect(ports.bountyEscrow.payout).toHaveBeenCalledTimes(1);
  });

  it("sends nothing when the read that decides it fails", async () => {
    const { actions, ports, seedFinding, seedContract, claim } = setup();
    const contractId = await seedContract();
    const findingId = seedFinding(contractId, "Submitted");
    await claim(contractId);
    ports.bountyEscrow.readBounty.mockRejectedValueOnce(new Error("rpc unavailable"));

    await expect(actions.applyVerdict(findingId, "Passed")).rejects.toThrow("rpc unavailable");
    expect(ports.bountyEscrow.recordSubmission).not.toHaveBeenCalled();
    expect(ports.bountyEscrow.recordVerification).not.toHaveBeenCalled();
  });
});

describe("unlock intent ('unlocking')", () => {
  it("a failed unlock leaves an intent that the sweep finishes with one send", async () => {
    const { actions, ports, seedFinding, seedContract, claim, store, chainStore } = setup();
    const contractId = await seedContract();
    const findingId = seedFinding(contractId, "Submitted");
    await claim(contractId);
    ports.auditorStaking.unlockSubmission.mockRejectedValueOnce(new Error("rpc unavailable"));

    await expect(actions.applyVerdict(findingId, "Failed")).rejects.toThrow("rpc unavailable");
    expect(store.contracts.get(contractId)?.claimLock).toBe("unlocking");
    await expect(chainStore.findUnlockingClaims(contractId)).resolves.toEqual([
      { contractId, auditorId: AUDITOR },
    ]);

    await expect(actions.finishPendingUnlocks()).resolves.toBe(1);
    expect(store.contracts.get(contractId)?.claimLock).toBe("released");
    expect(ports.auditorStaking.unlockSubmission).toHaveBeenCalledTimes(2);
    await expect(actions.finishPendingUnlocks()).resolves.toBe(0);
    expect(ports.auditorStaking.unlockSubmission).toHaveBeenCalledTimes(2);
  });

  it("does not send unlock again when the send landed but its marker write failed", async () => {
    const { actions, ports, seedFinding, seedContract, claim, store, chainStore } = setup();
    const contractId = await seedContract();
    const findingId = seedFinding(contractId, "Submitted");
    await claim(contractId);
    vi.spyOn(chainStore, "markClaimReleased").mockRejectedValueOnce(new Error("db write failed"));

    await expect(actions.applyVerdict(findingId, "Failed")).rejects.toThrow("db write failed");
    expect(ports.auditorStaking.unlockSubmission).toHaveBeenCalledTimes(1);
    expect(store.contracts.get(contractId)?.claimLock).toBe("unlocking");

    await expect(actions.finishPendingUnlocks()).resolves.toBe(1);
    expect(ports.auditorStaking.unlockSubmission).toHaveBeenCalledTimes(1);
    expect(store.contracts.get(contractId)?.claimLock).toBe("released");

    // The retried verdict now completes, and still does not unlock again.
    await expect(actions.applyVerdict(findingId, "Failed")).resolves.toBe("Rejected");
    expect(ports.auditorStaking.unlockSubmission).toHaveBeenCalledTimes(1);
  });

  it("a failed undo of a lock leaves an intent that survives the claim rollback and is released by the sweep", async () => {
    const { actions, ports, seedContract, repository, chainStore, store } = setup();
    const contractId = await seedContract();
    const expiresAt = new Date(T0.getTime() + CLAIM_WINDOW_MS);
    const result = await repository.claimContract(contractId, AUDITOR, expiresAt, T0);
    if (!result.ok) throw new Error("claim failed in test setup");
    vi.spyOn(chainStore, "markClaimLocked").mockRejectedValueOnce(new Error("db down"));
    ports.auditorStaking.unlockSubmission.mockRejectedValueOnce(new Error("rpc unavailable"));

    await expect(actions.lockClaim(contractId, AUDITOR)).rejects.toThrow("could not record its lock");
    expect(store.contracts.get(contractId)?.claimLock).toBe("unlocking");

    // The route rolls the claim back. The intent must not be dropped with it.
    await repository.releaseClaim(contractId, AUDITOR);
    expect(store.contracts.get(contractId)?.claimLock).toBe("unlocking");

    await expect(actions.finishPendingUnlocks()).resolves.toBe(1);
    expect(store.contracts.get(contractId)?.claimLock).toBe("released");
    expect(ports.auditorStaking.unlockSubmission).toHaveBeenCalledTimes(2);
  });

  it("a lock that did not record and whose undo succeeds leaves no intent", async () => {
    const { actions, ports, seedContract, repository, chainStore, store } = setup();
    const contractId = await seedContract();
    const expiresAt = new Date(T0.getTime() + CLAIM_WINDOW_MS);
    await repository.claimContract(contractId, AUDITOR, expiresAt, T0);
    vi.spyOn(chainStore, "markClaimLocked").mockRejectedValueOnce(new Error("db down"));

    await expect(actions.lockClaim(contractId, AUDITOR)).rejects.toThrow("could not record its lock");
    expect(ports.auditorStaking.unlockSubmission).toHaveBeenCalledTimes(1);
    expect(store.contracts.get(contractId)?.claimLock).not.toBe("unlocking");
    await expect(actions.finishPendingUnlocks()).resolves.toBe(0);
  });
});

describe("lock intent ('locking')", () => {
  it("a send that throws without landing clears the intent and releases cleanly", async () => {
    const { actions, ports, seedContract, repository, chainStore, store } = setup();
    const contractId = await seedContract();
    await repository.claimContract(contractId, AUDITOR, new Date(T0.getTime() + CLAIM_WINDOW_MS), T0);
    ports.auditorStaking.lockSubmission.mockRejectedValueOnce(new Error("timeout waiting for receipt"));

    await expect(actions.lockClaim(contractId, AUDITOR)).rejects.toThrow("timeout waiting for receipt");
    expect(store.contracts.get(contractId)?.claimLock).toBeNull();
    await expect(chainStore.findLockingClaims()).resolves.toEqual([]);

    // The route rolls the claim back. Nothing is left for the sweep.
    await repository.releaseClaim(contractId, AUDITOR);
    expect(store.contracts.get(contractId)).toMatchObject({ claimedByAuditorId: null, claimLock: null });
    await expect(repository.findContractById(contractId, T0)).resolves.toMatchObject({ status: "Open" });
    await expect(actions.finishPendingUnlocks()).resolves.toBe(0);
    expect(ports.auditorStaking.lockSubmission).toHaveBeenCalledTimes(1);
    expect(ports.auditorStaking.unlockSubmission).not.toHaveBeenCalled();
  });

  it("a send that throws after landing ends in 'unlocking' and the sweep unlocks it", async () => {
    const { actions, ports, seedContract, repository, store } = setup();
    const contractId = await seedContract();
    await repository.claimContract(contractId, AUDITOR, new Date(T0.getTime() + CLAIM_WINDOW_MS), T0);
    const lockLanded = ports.auditorStaking.lockSubmission.getMockImplementation()!;
    ports.auditorStaking.lockSubmission.mockImplementationOnce(async (auditor: Address) => {
      await lockLanded(auditor);
      throw new Error("timeout waiting for receipt");
    });

    await expect(actions.lockClaim(contractId, AUDITOR)).rejects.toThrow("timeout waiting for receipt");
    expect(store.contracts.get(contractId)?.claimLock).toBe("unlocking");

    // The route rolls the claim back; the holder and the intent survive.
    await repository.releaseClaim(contractId, AUDITOR);
    expect(store.contracts.get(contractId)).toMatchObject({ claimedByAuditorId: AUDITOR, claimLock: "unlocking" });

    await expect(actions.finishPendingUnlocks()).resolves.toBe(1);
    expect(store.contracts.get(contractId)?.claimLock).toBe("released");
    expect(ports.auditorStaking.unlockSubmission).toHaveBeenCalledTimes(1);
    await expect(actions.finishPendingUnlocks()).resolves.toBe(0);
    expect(ports.auditorStaking.unlockSubmission).toHaveBeenCalledTimes(1);
  });

  it("a crash after the send and before markClaimLocked is resolved by the sweep without a second lock", async () => {
    const { ports, seedContract, repository, chainStore, store, clock } = setup();
    const contractId = await seedContract();
    await repository.claimContract(contractId, AUDITOR, new Date(T0.getTime() + CLAIM_WINDOW_MS), T0);
    // What the first process wrote before it died: the intent, then a send that landed.
    await chainStore.markClaimLocking(contractId, AUDITOR, 0n);
    await ports.auditorStaking.lockSubmission(AUDITOR);
    expect(store.contracts.get(contractId)?.claimLock).toBe("locking");

    // A restarted process has empty in-memory queues over the same store.
    const restarted = createChainActions({
      store: chainStore,
      bountyEscrow: ports.bountyEscrow,
      auditorStaking: ports.auditorStaking,
      claimLockEnabled: true,
      now: () => clock.now,
      onError: () => {},
    });
    await expect(restarted.finishPendingUnlocks()).resolves.toBe(1);
    expect(ports.auditorStaking.lockSubmission).toHaveBeenCalledTimes(1);
    expect(ports.auditorStaking.unlockSubmission).toHaveBeenCalledTimes(1);
    expect(store.contracts.get(contractId)?.claimLock).toBe("released");
  });

  it("a crash before the send leaves an intent that the sweep clears without sending", async () => {
    const { ports, seedContract, repository, chainStore, store, clock } = setup();
    const contractId = await seedContract();
    await repository.claimContract(contractId, AUDITOR, new Date(T0.getTime() + CLAIM_WINDOW_MS), T0);
    await chainStore.markClaimLocking(contractId, AUDITOR, 0n);

    const restarted = createChainActions({
      store: chainStore,
      bountyEscrow: ports.bountyEscrow,
      auditorStaking: ports.auditorStaking,
      claimLockEnabled: true,
      now: () => clock.now,
      onError: () => {},
    });
    await expect(restarted.finishPendingUnlocks()).resolves.toBe(0);
    expect(ports.auditorStaking.lockSubmission).not.toHaveBeenCalled();
    expect(ports.auditorStaking.unlockSubmission).not.toHaveBeenCalled();
    expect(store.contracts.get(contractId)).toMatchObject({ claimedByAuditorId: AUDITOR, claimLock: null });
  });
});

describe("one claim per auditor", () => {
  it("refuses a second claim while the first is active, and allows one after it expires", async () => {
    const { seedContract, repository } = setup();
    const first = await seedContract();
    const second = await seedContract();
    const expiresAt = new Date(T0.getTime() + CLAIM_WINDOW_MS);
    await expect(repository.claimContract(first, AUDITOR, expiresAt, T0)).resolves.toMatchObject({ ok: true });

    await expect(repository.claimContract(second, AUDITOR, expiresAt, T0)).resolves.toEqual({
      ok: false,
      reason: "auditor_has_claim",
    });
    await expect(
      repository.claimContract(second, AUDITOR, new Date(expiresAt.getTime() + CLAIM_WINDOW_MS), expiresAt),
    ).resolves.toMatchObject({ ok: true });
  });

  it("refuses a second claim while the first is locked or unlocking, and allows it once the first is released", async () => {
    const { actions, ports, seedFinding, seedContract, claim, repository, store } = setup();
    const first = await seedContract();
    const second = await seedContract();
    const findingId = seedFinding(first, "Submitted");
    const expiresAt = new Date(T0.getTime() + CLAIM_WINDOW_MS);
    await claim(first);
    await expect(repository.claimContract(second, AUDITOR, expiresAt, T0)).resolves.toEqual({
      ok: false,
      reason: "auditor_has_claim",
    });

    ports.auditorStaking.unlockSubmission.mockRejectedValueOnce(new Error("rpc unavailable"));
    await expect(actions.applyVerdict(findingId, "Failed")).rejects.toThrow("rpc unavailable");
    expect(store.contracts.get(first)?.claimLock).toBe("unlocking");
    await repository.releaseClaim(first, AUDITOR);
    await expect(repository.claimContract(second, AUDITOR, expiresAt, T0)).resolves.toEqual({
      ok: false,
      reason: "auditor_has_claim",
    });

    await expect(actions.finishPendingUnlocks()).resolves.toBe(1);
    await expect(repository.claimContract(second, AUDITOR, expiresAt, T0)).resolves.toMatchObject({ ok: true });
  });
});

describe("no chain configured", () => {
  it("makes no chain calls and reports no payouts", async () => {
    const { actions, seedFinding, seedContract, claim, store } = setup({ withChain: false });
    const contractId = await seedContract();
    const findingId = seedFinding(contractId, "Submitted", { challengeWindowExpiresAt: T0.toISOString(), sandboxStatus: "Passed" });
    await claim(contractId);

    expect(actions.chainConfigured).toBe(false);
    await expect(actions.releaseExpiredLocks(new Date(T0.getTime() + CLAIM_WINDOW_MS * 2))).resolves.toBe(0);
    await expect(actions.applyDisputeResolved(findingId)).resolves.toBe(false);
    await expect(actions.runPayoutsOnce(T0)).resolves.toEqual({ due: 0, paid: 0, failed: 0 });
    // Status still follows the verdict; only the chain steps are skipped.
    await expect(actions.applyVerdict(findingId, "Passed")).resolves.toBe("Verified");
    expect(store.findings.get(findingId)?.status).toBe("Verified");
  });
});
