import type { FindingStatus } from "@bbm/shared";
import type { FindingStatusReader, FindingStatusWriter } from "../status/finding-writer.js";

/** Finding statuses that still need the auditor's stake: the verdict, the
 * payout or the dispute is outstanding, and BountyEscrow refuses the
 * verification or payout (AuditorNotEligible) if the stake was withdrawn. The
 * claim lock backing such a finding stays in place. */
export const PENDING_FINDING_STATUSES: ReadonlySet<FindingStatus> = new Set([
  "Submitted",
  "Verified",
  "Disputed",
]);

/** A finding as the chain actions need it. */
export interface FindingChainRef {
  findingId: string;
  contractId: string;
  status: FindingStatus;
  /** Auditor on the finding's latest PoC; null when no PoC was uploaded. */
  auditorId: string | null;
  /** True once BountyEscrow.recordVerification has been confirmed for it. */
  verificationRecorded: boolean;
}

/** A Verified finding whose challenge window has closed and whose payout has
 * not been sent yet. */
export interface PayoutDue {
  findingId: string;
  contractId: string;
  auditorId: string;
}

/**
 * Persistence for chain actions: the claim lock state, and the markers that
 * make each BountyEscrow write happen at most once. Findings are read and
 * written through the shared status interfaces.
 *
 * Claim lock states: null (never locked), "locking" (a lock is intended but
 * not yet confirmed; the row records the lock count read before the send, so
 * the sweep can tell whether it landed), "locked", "unlocking" (an unlock is
 * intended but not yet confirmed; the sweep finishes it), "released".
 */
export interface ChainActionStore extends FindingStatusReader, FindingStatusWriter {
  findFinding(findingId: string): Promise<FindingChainRef | null>;

  isSubmissionRecorded(contractId: string): Promise<boolean>;
  markSubmissionRecorded(contractId: string, at: Date): Promise<void>;
  markVerificationRecorded(findingId: string, at: Date): Promise<void>;

  /** Sets the current claim to "locking" and records `before`, the lock count
   * read before the send. False, changing nothing, when the claim is not held
   * by `auditorId` or already has a lock state. */
  markClaimLocking(contractId: string, auditorId: string, before: bigint): Promise<boolean>;
  /** Clears a "locking" intent held by `auditorId`: the lock did not land. */
  clearClaimLocking(contractId: string, auditorId: string): Promise<void>;
  /** Claims in "locking". `lockBefore` is the count recorded with the intent,
   * or null when none was recorded. Filtered to one contract when given. */
  findLockingClaims(
    contractId?: string,
  ): Promise<{ contractId: string; auditorId: string; lockBefore: bigint | null }[]>;
  /** Sets the current claim from "locking" to "locked". False when the claim is
   * not in "locking" for this auditor. */
  markClaimLocked(contractId: string, auditorId: string): Promise<boolean>;
  /**
   * Atomically flips a "locked" claim to "unlocking" and returns the auditor
   * whose lock must be unlocked. Returns null, changing nothing, when there is
   * no lock to take: never locked, already unlocking or released, held by
   * someone else (when `auditorId` is given), or, when `expiredBy` is given,
   * not yet expired or still backing a pending finding (see
   * listExpiredLockedClaims).
   */
  takeClaimUnlock(
    contractId: string,
    options: { auditorId?: string; expiredBy?: Date },
  ): Promise<string | null>;
  /** Claims in "unlocking": an unlock was intended but is not yet confirmed.
   * Filtered to one contract when `contractId` is given. */
  findUnlockingClaims(contractId?: string): Promise<{ contractId: string; auditorId: string }[]>;
  /** Sets the claim to "unlocking" if it is still held by `auditorId`. False
   * when it is not. Used when a lock or its undo failed after the lock landed. */
  markClaimUnlocking(contractId: string, auditorId: string): Promise<boolean>;
  /** Sets an "unlocking" claim held by `auditorId` to "released". */
  markClaimReleased(contractId: string, auditorId: string): Promise<void>;
  /** Locked claims whose expiry is at or before `now`, except those whose
   * auditor has a Submitted, Verified or Disputed finding on the contract.
   * That lock keeps the stake in place until the finding is paid or
   * rejected: unlocked, the auditor could withdraw and BountyEscrow would
   * refuse the verification or payout (AuditorNotEligible). */
  listExpiredLockedClaims(
    now: Date,
    contractId?: string,
  ): Promise<{ contractId: string; auditorId: string }[]>;

  /** Verified findings past their challenge window with no payout sent yet. */
  listPayoutsDue(now: Date): Promise<PayoutDue[]>;
  markPayoutSent(findingId: string, at: Date): Promise<void>;
}

export interface ChainActionStoreOptions {
  /** BountyEscrow's challenge window, used to set
   * findings.challenge_window_expires_at when a finding becomes Verified.
   * Defaults to the deploy script's 3 days. */
  challengeWindowSeconds?: number;
}

export const DEFAULT_CHALLENGE_WINDOW_SECONDS = 259_200;

/** ISO time the challenge window opened at `changedAt` closes. */
export function challengeWindowEnd(changedAt: string, windowSeconds: number): string {
  return new Date(Date.parse(changedAt) + windowSeconds * 1000).toISOString();
}
