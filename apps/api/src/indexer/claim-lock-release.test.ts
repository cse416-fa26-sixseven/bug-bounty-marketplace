import { describe, expect, it, vi } from "vitest";
import type { Hash } from "viem";
import type { FindingStatus } from "@bbm/shared";
import { createChainActions } from "../chain/actions.js";
import type { AuditorStakingPort } from "../chain/auditor-staking.js";
import { MemoryChainActionStore } from "../chain/memory-action-store.js";
import { MemoryContractRepository } from "../contracts/memory-repository.js";
import { MemoryStore } from "../pipeline/memory-repository.js";
import { makeContract, makeFinding } from "../testing/repository-suite.js";
import { claimLockReleaser } from "./claim-lock-release.js";

const AT = "2026-10-20T12:00:00.000Z";
const AUDITOR = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const HASH = `0x${"ab".repeat(32)}` as Hash;

describe("claimLockReleaser", () => {
  it("releases the claim lock once the bounty is paid or a dispute goes against the auditor", async () => {
    const applyDisputeResolved = vi.fn(async () => true);
    const release = claimLockReleaser({ applyDisputeResolved });

    await release("finding_paid", "Paid", "PayoutCredited");
    await release("finding_lost", "Rejected", "Unfrozen");
    await release("finding_verified", "Verified", "FindingVerified");
    await release("finding_frozen", "Disputed", "Frozen");

    expect(applyDisputeResolved.mock.calls).toEqual([["finding_paid"], ["finding_lost"]]);
  });

  it("keeps the lock when the auditor wins the dispute, until the payout", async () => {
    // Unlocked here, the auditor could withdraw and BountyEscrow.payout would
    // revert AuditorNotEligible.
    const applyDisputeResolved = vi.fn(async () => true);
    const release = claimLockReleaser({ applyDisputeResolved });

    await release("finding_won", "Verified", "Unfrozen");
    expect(applyDisputeResolved).not.toHaveBeenCalled();

    await release("finding_won", "Paid", "PayoutCredited");
    expect(applyDisputeResolved.mock.calls).toEqual([["finding_won"]]);
  });

  it("with the real chain actions, a lost dispute keeps the lock another pending finding needs", async () => {
    const mem = new MemoryStore();
    const contracts = new MemoryContractRepository(mem);
    let active = 0n;
    const auditorStaking = {
      stakeOf: vi.fn(async () => 0n),
      reputation: vi.fn(async () => 0n),
      activeSubmissions: vi.fn(async () => active),
      lockSubmission: vi.fn(async () => {
        active += 1n;
        return HASH;
      }),
      unlockSubmission: vi.fn(async () => {
        active -= 1n;
        return HASH;
      }),
    } satisfies AuditorStakingPort;
    const actions = createChainActions({
      store: new MemoryChainActionStore(mem),
      auditorStaking,
      claimLockEnabled: true,
    });
    const record = makeContract();
    await contracts.insertContract(record);
    const contractId = record.contract.id;
    const seed = (status: FindingStatus) => {
      const finding = makeFinding(contractId, { status, statusHistory: [{ status, changedAt: AT }] });
      mem.findings.set(finding.id, finding);
      mem.pocs.set(`poc_${finding.id}`, {
        id: `poc_${finding.id}`,
        findingId: finding.id,
        auditorId: AUDITOR,
        testFileReference: "pocs/x.t.sol",
        submittedAt: AT,
        sandboxStatus: "Passed",
        sandboxLog: null,
      });
      return finding.id;
    };
    const lost = seed("Rejected");
    const other = seed("Verified");
    expect((await contracts.claimContract(contractId, AUDITOR, new Date(Date.parse(AT) + 60_000), new Date(AT))).ok).toBe(true);
    await actions.lockClaim(contractId, AUDITOR);
    const release = claimLockReleaser(actions);

    await release(lost, "Rejected", "Unfrozen");
    expect(auditorStaking.unlockSubmission).not.toHaveBeenCalled();

    mem.findings.get(other)!.status = "Paid";
    await release(other, "Paid", "PayoutCredited");
    expect(auditorStaking.unlockSubmission).toHaveBeenCalledTimes(1);
  });
});
