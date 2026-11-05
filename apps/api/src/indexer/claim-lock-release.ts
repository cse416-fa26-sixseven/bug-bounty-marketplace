import type { FindingStatus } from "@bbm/shared";
import type { ChainActions } from "../chain/actions.js";

/**
 * The indexer's onStatusApplied hook: releases the auditor's claim lock (and
 * so their stake) once nothing more can happen to the claimed bounty - after
 * the payout (PayoutCredited) or after a dispute goes against the auditor
 * (Unfrozen to Rejected). A dispute the auditor won (Unfrozen to Verified)
 * keeps the lock until its payout: unlocked, the auditor could withdraw and
 * BountyEscrow.payout would revert AuditorNotEligible. Without the payout case
 * a paid auditor could not claim another bounty until the claim expired.
 * applyDisputeResolved unlocks at most once per claim.
 */
export function claimLockReleaser(
  chainActions: Pick<ChainActions, "applyDisputeResolved">,
): (findingId: string, status: FindingStatus, eventName: string) => Promise<void> {
  return async (findingId, status, eventName) => {
    if (eventName === "PayoutCredited" || (eventName === "Unfrozen" && status === "Rejected")) {
      await chainActions.applyDisputeResolved(findingId);
    }
  };
}
