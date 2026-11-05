import { describe, expect, it, vi } from "vitest";
import { claimLockReleaser } from "./claim-lock-release.js";

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
});
