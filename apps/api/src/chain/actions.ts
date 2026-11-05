import type { Address, Hex } from "viem";
import type { FindingStatus } from "@bbm/shared";
import { PENDING_FINDING_STATUSES, type ChainActionStore, type PayoutDue } from "./action-store.js";
import type { AuditorStakingPort } from "./auditor-staking.js";
import {
  BOUNTY_STATE_CLOSED,
  BOUNTY_STATE_PAID,
  type BountyEscrowPort,
  type OnchainBounty,
} from "./bounty-escrow.js";
import { onchainId } from "./ids.js";
import { FindingNotFoundError, applyFindingTransition } from "../status/finding-writer.js";
import { transitionFinding } from "../status/transitions.js";

export type Verdict = "Passed" | "Failed";

const ZERO_FINDING: Hex = `0x${"0".repeat(64)}`;

/**
 * A Passed verdict that cannot be applied yet: the bounty is open but another
 * finding is verified on it, and BountyEscrow pays only the first verified
 * finding (R10). Nothing was sent and the finding stays Submitted. It is not a
 * failure: the verdict is retried later, and applies if that verification is
 * cleared (a lost dispute) or is rejected once the bounty is paid.
 */
export class VerdictDeferredError extends Error {
  constructor(
    readonly findingId: string,
    readonly verifiedFinding: Hex,
  ) {
    super(`Verdict for finding ${findingId} deferred: bounty already verified finding ${verifiedFinding}`);
    this.name = "VerdictDeferredError";
  }
}

export interface ChainActionsDeps {
  store: ChainActionStore;
  /** Absent when no chain is configured: every BountyEscrow step is skipped. */
  bountyEscrow?: BountyEscrowPort;
  /** Absent when no chain is configured or CLAIM_LOCK_ENABLED is off. */
  auditorStaking?: AuditorStakingPort;
  /** CLAIM_LOCK_ENABLED. Lock and unlock are skipped when false, even with a port. */
  claimLockEnabled: boolean;
  now?: () => Date;
  /** Where best-effort failures are reported. Defaults to console.error. */
  onError?: (message: string, err: unknown) => void;
}

export interface PayoutRunSummary {
  due: number;
  paid: number;
  failed: number;
}

/** Operator-side chain actions. Each chain write is preceded by a read of the
 * chain state it would change, so a retry after a send whose marker write
 * failed does not send again. */
export interface ChainActions {
  /** True when a chain port is configured. Routes use it to require a
   * 0x-address for auditor ids, since payouts go to that address. */
  readonly chainConfigured: boolean;
  /** Locks the auditor's stake for a claim just made. Throws when the lock
   * cannot be sent or recorded; the caller then releases the claim. */
  lockClaim(contractId: string, auditorId: string): Promise<void>;
  /** Finishes unlocks of claims in 'unlocking' and unlocks claims whose expiry
   * has passed. Returns how many claims were released. Throws the first
   * failure after trying the rest. */
  releaseExpiredLocks(now: Date, contractId?: string): Promise<number>;
  /** The contract's bounty is closed on-chain (cancelled or refunded), so no
   * verification or payout can follow: releases the claim lock on it whatever
   * its expiry and findings, unlike the expiry sweep, which keeps a lock that
   * backs a pending finding. Also finishes an unlock an earlier attempt left
   * in 'unlocking'. Returns true if a lock was released; throws when the
   * unlock fails. */
  releaseClaimLock(contractId: string): Promise<boolean>;
  /** The sweep the keeper runs: settles every claim left in 'locking' (the lock
   * landed: unlock it; it did not: clear the intent) and finishes every claim
   * left in 'unlocking'. Returns how many claims were released. */
  finishPendingUnlocks(): Promise<number>;
  /**
   * Applies a sandbox verdict to a Submitted finding.
   * Passed: records the submission (once per contract) and the verification
   * on BountyEscrow, then moves the finding to Verified. BountyEscrow takes one
   * verified finding per bounty, so when it already holds another: if the
   * bounty is settled (Paid or Closed) the finding can never be paid and is
   * handled as Failed (returns Rejected); if it is still open, nothing is sent
   * and VerdictDeferredError is thrown, so the verdict is retried later.
   * Failed: unlocks the auditor's claim lock, then moves the finding to Rejected.
   * Chain steps run first. If one throws, the finding status is unchanged and
   * the call can be retried.
   */
  applyVerdict(findingId: string, verdict: Verdict): Promise<FindingStatus>;
  /** Called once nothing more can happen to the finding: it was paid
   * (PayoutCredited) or a dispute went against the auditor (Rejected). Unlocks
   * the claim lock once. Does nothing while the finding is Submitted, Verified
   * or Disputed (a dispute the auditor won returns it to Verified, awaiting
   * payout), since the payout still needs the stake. After a Rejected one, also
   * keeps the lock while the auditor has another pending finding on the
   * contract; after a payout, releases it regardless. Returns true if this
   * call released a lock. */
  applyDisputeResolved(findingId: string): Promise<boolean>;
  /** Pays every Verified finding whose challenge window has closed. A failed
   * payout is logged and left for the next run. Does not set Paid: that
   * happens when PayoutCredited is indexed. */
  runPayoutsOnce(now: Date): Promise<PayoutRunSummary>;
}

export function createChainActions(deps: ChainActionsDeps): ChainActions {
  const { store, bountyEscrow, auditorStaking, claimLockEnabled } = deps;
  const now = deps.now ?? (() => new Date());
  const onError =
    deps.onError ?? ((message: string, err: unknown) => console.error(message, err));
  const lockEnabled = claimLockEnabled && auditorStaking !== undefined;

  /** Per-contract queues in this process. Two unlocks of one claim must never
   * read and send at the same time, or both could see the lock and send. */
  const contractQueues = new Map<string, Promise<unknown>>();
  function serialize<T>(contractId: string, task: () => Promise<T>): Promise<T> {
    const run = (contractQueues.get(contractId) ?? Promise.resolve()).then(task);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    contractQueues.set(contractId, tail);
    void tail.then(() => {
      if (contractQueues.get(contractId) === tail) contractQueues.delete(contractId);
    });
    return run;
  }

  /**
   * Finishes one claim's unlock. Reads activeSubmissions first: zero means
   * the lock is already gone (an earlier send landed), so only the marker is
   * written. The claim stays 'unlocking' until a call here returns, so a
   * failure at any point leaves an intent the sweep finishes.
   */
  async function finishUnlock(contractId: string, auditorId: string): Promise<void> {
    if (!auditorStaking) return;
    const staker = auditorId as Address;
    if ((await auditorStaking.activeSubmissions(staker)) > 0n) {
      await auditorStaking.unlockSubmission(staker);
    }
    await store.markClaimReleased(contractId, auditorId);
  }

  /**
   * Settles one lock intent ('locking'). The send may or may not have landed,
   * so the count is read first: it must have risen past the count recorded
   * before the send. If it did, the claim becomes 'unlocking' and the unlock is
   * finished. If it did not, or no count was recorded, the intent is cleared.
   * Nothing is sent unless the lock landed. Returns true when a lock was released.
   */
  async function settleLockIntent(claim: {
    contractId: string;
    auditorId: string;
    lockBefore: bigint | null;
  }): Promise<boolean> {
    if (!auditorStaking) return false;
    const landed =
      claim.lockBefore !== null &&
      (await auditorStaking.activeSubmissions(claim.auditorId as Address)) > claim.lockBefore;
    if (!landed) {
      await store.clearClaimLocking(claim.contractId, claim.auditorId);
      return false;
    }
    if (!(await store.markClaimUnlocking(claim.contractId, claim.auditorId))) {
      throw new Error(`claim ${claim.contractId} is no longer held by ${claim.auditorId}`);
    }
    await finishUnlock(claim.contractId, claim.auditorId);
    return true;
  }

  /** Finishes every claim in 'locking' and 'unlocking' for one contract. The
   * caller holds that contract's queue. Returns how many locks were released. */
  async function finishUnlockingFor(contractId: string): Promise<number> {
    let released = 0;
    for (const claim of await store.findLockingClaims(contractId)) {
      if (await settleLockIntent(claim)) released += 1;
    }
    const pending = await store.findUnlockingClaims(contractId);
    for (const claim of pending) {
      await finishUnlock(claim.contractId, claim.auditorId);
    }
    return released + pending.length;
  }

  /**
   * A lock send threw. Reads whether the lock landed (the count rose past
   * `before`): if so the claim becomes 'unlocking' and the sweep unlocks it;
   * if not the intent is cleared. A read or write that fails leaves the
   * 'locking' intent for the sweep, which decides from the chain. Never throws.
   */
  async function settleFailedLock(contractId: string, auditorId: string, before: bigint): Promise<void> {
    if (!auditorStaking) return;
    let landed: boolean;
    try {
      landed = (await auditorStaking.activeSubmissions(auditorId as Address)) > before;
    } catch (err) {
      onError(`activeSubmissions read failed after a lock send on ${contractId}; the sweep will decide`, err);
      return;
    }
    try {
      if (!landed) {
        await store.clearClaimLocking(contractId, auditorId);
      } else if (!(await store.markClaimUnlocking(contractId, auditorId))) {
        onError(`claim ${contractId} is no longer held by ${auditorId}; its lock needs manual release`, undefined);
      }
    } catch (err) {
      onError(`recording the lock outcome for ${contractId} failed; the sweep will decide`, err);
    }
  }

  /** Finishes every 'unlocking' claim, or those of one contract. Each contract
   * is tried even when an earlier one fails; the first failure is rethrown. */
  async function finishUnlocking(contractId?: string): Promise<number> {
    const pending = [
      ...(await store.findLockingClaims(contractId)),
      ...(await store.findUnlockingClaims(contractId)),
    ];
    let released = 0;
    let firstError: { err: unknown } | undefined;
    for (const id of new Set(pending.map((claim) => claim.contractId))) {
      try {
        released += await serialize(id, () => finishUnlockingFor(id));
      } catch (err) {
        firstError ??= { err };
      }
    }
    if (firstError) throw firstError.err;
    return released;
  }

  /**
   * Takes the claim's lock (locked -> unlocking) and finishes it. If there is
   * no lock to take, finishes any unlock an earlier attempt left in
   * 'unlocking', so a failed Failed-verdict unlock is retried by the next call.
   * Returns true when this call released a lock.
   */
  async function unlock(
    contractId: string,
    options: { auditorId?: string; expiredBy?: Date; settling?: string },
  ): Promise<boolean> {
    if (!lockEnabled) return false;
    return serialize(contractId, async () => {
      const auditorId = await store.takeClaimUnlock(contractId, options);
      if (auditorId !== null) {
        await finishUnlock(contractId, auditorId);
        return true;
      }
      return (await finishUnlockingFor(contractId)) > 0;
    });
  }

  /** The undo of a lock failed. Persists an 'unlocking' intent so the sweep
   * releases the lock, but only when the chain shows the lock landed (the
   * count rose above `before`). */
  async function recordUndoFailure(contractId: string, auditorId: string, before: bigint): Promise<void> {
    if (!auditorStaking) return;
    let landed = true;
    try {
      landed = (await auditorStaking.activeSubmissions(auditorId as Address)) > before;
    } catch (err) {
      onError(`activeSubmissions read failed after an undo failure on ${contractId}`, err);
    }
    if (!landed) return;
    try {
      const marked = await store.markClaimUnlocking(contractId, auditorId);
      if (!marked) {
        onError(`claim ${contractId} is no longer held by ${auditorId}; its lock needs manual release`, undefined);
      }
    } catch (err) {
      onError(`markClaimUnlocking failed for contract ${contractId}; its lock needs manual release`, err);
    }
  }

  /** What a Passed verdict can do on this bounty: 'record' when the bounty
   * takes (or already holds) this finding's verification, 'settled' when it
   * is Paid or Closed without it, 'deferred' when it is open with another
   * finding verified. */
  function passedOutcome(bounty: OnchainBounty, finding: Hex): "record" | "settled" | "deferred" {
    const verified = bounty.verifiedFinding.toLowerCase();
    if (verified === finding.toLowerCase()) return "record";
    // None (not funded on-chain) is not settled: it may still be funded, and
    // the claim queue lists funded contracts only. It goes on as before.
    if (bounty.state === BOUNTY_STATE_PAID || bounty.state === BOUNTY_STATE_CLOSED) return "settled";
    if (verified !== ZERO_FINDING) return "deferred";
    return "record";
  }

  /** Sends recordSubmission only while the bounty counts no submission. */
  async function ensureSubmissionRecorded(port: BountyEscrowPort, contractId: string): Promise<void> {
    const key = onchainId(contractId);
    const bounty = await port.readBounty(key);
    if (bounty.submissionCount > 0n) return;
    await port.recordSubmission(key);
  }

  /** Sends recordVerification only while the bounty's verified finding is not this one. */
  async function ensureVerificationRecorded(
    port: BountyEscrowPort,
    contractId: string,
    findingId: string,
    auditor: Address,
  ): Promise<void> {
    const key = onchainId(contractId);
    const finding = onchainId(findingId);
    const bounty = await port.readBounty(key);
    if (bounty.verifiedFinding.toLowerCase() === finding.toLowerCase()) return;
    await port.recordVerification(key, finding, auditor);
  }

  /** Sends payout only while the bounty is not already Paid for this finding. */
  async function ensurePaid(port: BountyEscrowPort, item: PayoutDue): Promise<void> {
    const key = onchainId(item.contractId);
    const finding = onchainId(item.findingId);
    const bounty = await port.readBounty(key);
    if (
      bounty.state === BOUNTY_STATE_PAID &&
      bounty.verifiedFinding.toLowerCase() === finding.toLowerCase()
    ) {
      return;
    }
    await port.payout(key, finding, item.auditorId as Address);
  }

  return {
    chainConfigured: bountyEscrow !== undefined || auditorStaking !== undefined,

    async lockClaim(contractId, auditorId) {
      if (!lockEnabled || !auditorStaking) return;
      await serialize(contractId, async () => {
        const staker = auditorId as Address;
        // Read before the send, so an intent records the count to compare with.
        const before = await auditorStaking.activeSubmissions(staker);
        // The intent is written before the send. A crash after the send leaves
        // it for the sweep, which compares the count with `before`.
        if (!(await store.markClaimLocking(contractId, auditorId, before))) {
          throw new Error(`Claim on ${contractId} is not held by ${auditorId}`);
        }
        try {
          await auditorStaking.lockSubmission(staker);
        } catch (err) {
          await settleFailedLock(contractId, auditorId, before);
          throw err;
        }
        let recorded = false;
        try {
          recorded = await store.markClaimLocked(contractId, auditorId);
        } catch (err) {
          onError(`markClaimLocked failed for contract ${contractId}`, err);
        }
        if (recorded) return;
        // The stake is locked on-chain but the claim cannot record it, so no
        // unlock would ever run. Undo the lock now and let the caller fail.
        try {
          await auditorStaking.unlockSubmission(staker);
        } catch (err) {
          onError(`unlockSubmission failed while undoing a lock on ${contractId}`, err);
          await recordUndoFailure(contractId, auditorId, before);
          throw new Error(`Claim on ${contractId} could not record its lock`, { cause: err });
        }
        await store.clearClaimLocking(contractId, auditorId);
        throw new Error(`Claim on ${contractId} could not record its lock`);
      });
    },

    async releaseExpiredLocks(at, contractId) {
      if (!lockEnabled) return 0;
      // Pending unlocks go first: a new claim on the contract overwrites the row.
      let unlocked = 0;
      let firstError: { err: unknown } | undefined;
      try {
        unlocked += await finishUnlocking(contractId);
      } catch (err) {
        firstError ??= { err };
      }
      const expired = await store.listExpiredLockedClaims(at, contractId);
      for (const claim of expired) {
        try {
          if (await unlock(claim.contractId, { auditorId: claim.auditorId, expiredBy: at })) {
            unlocked += 1;
          }
        } catch (err) {
          firstError ??= { err };
        }
      }
      if (firstError) throw firstError.err;
      return unlocked;
    },

    async releaseClaimLock(contractId) {
      return unlock(contractId, {});
    },

    async finishPendingUnlocks() {
      if (!lockEnabled) return 0;
      return finishUnlocking();
    },

    async applyVerdict(findingId, verdict) {
      const ref = await store.findFinding(findingId);
      if (!ref) throw new FindingNotFoundError(findingId);
      const target: FindingStatus = verdict === "Passed" ? "Verified" : "Rejected";
      if (ref.status === target) return target;
      // Reject an illegal move before any chain call is sent.
      transitionFinding(ref.status, target);
      if (ref.auditorId === null) {
        throw new Error(`Finding ${findingId} has no PoC, so it has no auditor`);
      }

      if (verdict === "Passed") {
        if (bountyEscrow && !ref.verificationRecorded) {
          // Read before any send: recordSubmission and recordVerification
          // revert once the bounty is settled or holds another verification.
          const bounty = await bountyEscrow.readBounty(onchainId(ref.contractId));
          const outcome = passedOutcome(bounty, onchainId(findingId));
          if (outcome === "deferred") throw new VerdictDeferredError(findingId, bounty.verifiedFinding);
          if (outcome === "settled") {
            // Never verifiable or payable: settled as a Failed verdict is.
            await unlock(ref.contractId, { auditorId: ref.auditorId, settling: findingId });
            return applyFindingTransition(store, findingId, "Rejected", now().toISOString());
          }
          if (!(await store.isSubmissionRecorded(ref.contractId))) {
            await ensureSubmissionRecorded(bountyEscrow, ref.contractId);
            await store.markSubmissionRecorded(ref.contractId, now());
          }
          await ensureVerificationRecorded(
            bountyEscrow,
            ref.contractId,
            findingId,
            ref.auditorId as Address,
          );
          await store.markVerificationRecorded(findingId, now());
        }
      } else {
        // Kept while another finding of the auditor's on this contract is
        // pending: its verification or payout still needs the stake.
        await unlock(ref.contractId, { auditorId: ref.auditorId, settling: findingId });
      }

      return applyFindingTransition(store, findingId, target, now().toISOString());
    },

    async applyDisputeResolved(findingId) {
      const ref = await store.findFinding(findingId);
      if (!ref) throw new FindingNotFoundError(findingId);
      // A won dispute returns the finding to Verified: its payout still needs
      // the stake, so the lock stays until PayoutCredited.
      if (PENDING_FINDING_STATUSES.has(ref.status)) return false;
      // Paid: the bounty is closed, so no other finding on it can be verified
      // or paid, and the lock goes. Rejected (a lost dispute): kept while
      // another finding of the auditor's on this contract is pending.
      return unlock(ref.contractId, {
        auditorId: ref.auditorId ?? undefined,
        ...(ref.status === "Paid" ? {} : { settling: findingId }),
      });
    },

    async runPayoutsOnce(at) {
      if (!bountyEscrow) return { due: 0, paid: 0, failed: 0 };
      const due = await store.listPayoutsDue(at);
      const summary: PayoutRunSummary = { due: due.length, paid: 0, failed: 0 };
      for (const item of due) {
        try {
          await ensurePaid(bountyEscrow, item);
        } catch (err) {
          summary.failed += 1;
          onError(`payout failed for finding ${item.findingId}; left for the next run`, err);
          continue;
        }
        summary.paid += 1;
        await store.markPayoutSent(item.findingId, at);
      }
      return summary;
    },
  };
}
