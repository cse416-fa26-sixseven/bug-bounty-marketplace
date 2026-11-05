import type { FindingStatus } from "@bbm/shared";
import type { MemoryStore } from "../pipeline/memory-repository.js";
import type { ChainActionStore, ChainActionStoreOptions, FindingChainRef, PayoutDue } from "./action-store.js";
import { DEFAULT_CHALLENGE_WINDOW_SECONDS, challengeWindowEnd } from "./action-store.js";
import { InvalidTransitionError, canTransitionFinding } from "../status/transitions.js";

/** Findings whose claim lock must outlive the claim. */
const PENDING_STATUSES: ReadonlySet<FindingStatus> = new Set(["Submitted", "Verified", "Disputed"]);

/** In-memory ChainActionStore over the same MemoryStore the repositories use.
 * Tests and the no-DATABASE_URL setup. */
export class MemoryChainActionStore implements ChainActionStore {
  private readonly submissionRecorded = new Set<string>();
  private readonly verificationRecorded = new Set<string>();
  private readonly payoutSent = new Set<string>();

  private readonly challengeWindowSeconds: number;

  constructor(
    private readonly store: MemoryStore,
    options: ChainActionStoreOptions = {},
  ) {
    this.challengeWindowSeconds = options.challengeWindowSeconds ?? DEFAULT_CHALLENGE_WINDOW_SECONDS;
  }

  async getFindingStatus(findingId: string): Promise<FindingStatus | null> {
    return this.store.findings.get(findingId)?.status ?? null;
  }

  async setFindingStatus(findingId: string, status: FindingStatus, changedAt: string): Promise<void> {
    const record = this.store.findings.get(findingId);
    if (!record) throw new Error(`Finding not found: ${findingId}`);
    if (record.status === status) return;
    if (!canTransitionFinding(record.status, status)) {
      throw new InvalidTransitionError("finding", record.status, status);
    }
    record.status = status;
    record.statusHistory = [...record.statusHistory, { status, changedAt }];
    if (status === "Verified") {
      record.challengeWindowExpiresAt = challengeWindowEnd(changedAt, this.challengeWindowSeconds);
    }
    if (status === "Paid") {
      const stored = this.store.contracts.get(record.contractId);
      if (stored && (stored.contract.status === "Open" || stored.contract.status === "Claimed")) {
        stored.contract = { ...stored.contract, status: "Resolved" };
      }
    }
  }

  async findFinding(findingId: string): Promise<FindingChainRef | null> {
    const record = this.store.findings.get(findingId);
    if (!record) return null;
    const latestPoc = [...this.store.pocs.values()]
      .filter((poc) => poc.findingId === findingId)
      .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))[0];
    return {
      findingId,
      contractId: record.contractId,
      status: record.status,
      auditorId: latestPoc?.auditorId ?? null,
      verificationRecorded: this.verificationRecorded.has(findingId),
    };
  }

  async isSubmissionRecorded(contractId: string): Promise<boolean> {
    return this.submissionRecorded.has(contractId);
  }

  async markSubmissionRecorded(contractId: string): Promise<void> {
    this.submissionRecorded.add(contractId);
  }

  async markVerificationRecorded(findingId: string): Promise<void> {
    this.verificationRecorded.add(findingId);
  }

  async markClaimLocking(contractId: string, auditorId: string, before: bigint): Promise<boolean> {
    const stored = this.store.contracts.get(contractId);
    if (!stored || stored.contract.status !== "Claimed" || stored.claimedByAuditorId !== auditorId) {
      return false;
    }
    if (stored.claimLock !== null) return false;
    stored.claimLock = "locking";
    stored.claimLockBefore = before;
    return true;
  }

  async clearClaimLocking(contractId: string, auditorId: string): Promise<void> {
    const stored = this.store.contracts.get(contractId);
    if (stored?.claimLock !== "locking" || stored.claimedByAuditorId !== auditorId) return;
    stored.claimLock = null;
    stored.claimLockBefore = null;
    if (stored.contract.status !== "Claimed") stored.claimedByAuditorId = null;
  }

  async findLockingClaims(
    contractId?: string,
  ): Promise<{ contractId: string; auditorId: string; lockBefore: bigint | null }[]> {
    const out: { contractId: string; auditorId: string; lockBefore: bigint | null }[] = [];
    for (const [id, stored] of this.store.contracts) {
      if (contractId !== undefined && id !== contractId) continue;
      if (stored.claimLock !== "locking" || !stored.claimedByAuditorId) continue;
      out.push({ contractId: id, auditorId: stored.claimedByAuditorId, lockBefore: stored.claimLockBefore });
    }
    return out;
  }

  async markClaimLocked(contractId: string, auditorId: string): Promise<boolean> {
    const stored = this.store.contracts.get(contractId);
    if (
      !stored ||
      stored.contract.status !== "Claimed" ||
      stored.claimedByAuditorId !== auditorId ||
      stored.claimLock !== "locking"
    ) {
      return false;
    }
    stored.claimLock = "locked";
    stored.claimLockBefore = null;
    return true;
  }

  async takeClaimUnlock(
    contractId: string,
    options: { auditorId?: string; expiredBy?: Date },
  ): Promise<string | null> {
    const stored = this.store.contracts.get(contractId);
    if (!stored || stored.claimLock !== "locked" || !stored.claimedByAuditorId) return null;
    if (options.auditorId !== undefined && options.auditorId !== stored.claimedByAuditorId) return null;
    if (options.expiredBy !== undefined) {
      if (!stored.claimExpiresAt || stored.claimExpiresAt.getTime() > options.expiredBy.getTime()) {
        return null;
      }
      if (this.holdsPendingFinding(contractId, stored.claimedByAuditorId)) return null;
    }
    stored.claimLock = "unlocking";
    return stored.claimedByAuditorId;
  }

  async findUnlockingClaims(contractId?: string): Promise<{ contractId: string; auditorId: string }[]> {
    const out: { contractId: string; auditorId: string }[] = [];
    for (const [id, stored] of this.store.contracts) {
      if (contractId !== undefined && id !== contractId) continue;
      if (stored.claimLock !== "unlocking" || !stored.claimedByAuditorId) continue;
      out.push({ contractId: id, auditorId: stored.claimedByAuditorId });
    }
    return out;
  }

  async markClaimUnlocking(contractId: string, auditorId: string): Promise<boolean> {
    const stored = this.store.contracts.get(contractId);
    if (!stored || stored.claimedByAuditorId !== auditorId) return false;
    stored.claimLock = "unlocking";
    stored.claimLockBefore = null;
    return true;
  }

  async markClaimReleased(contractId: string, auditorId: string): Promise<void> {
    const stored = this.store.contracts.get(contractId);
    if (stored?.claimLock === "unlocking" && stored.claimedByAuditorId === auditorId) {
      stored.claimLock = "released";
    }
  }

  async listExpiredLockedClaims(
    now: Date,
    contractId?: string,
  ): Promise<{ contractId: string; auditorId: string }[]> {
    const out: { contractId: string; auditorId: string }[] = [];
    for (const [id, stored] of this.store.contracts) {
      if (contractId !== undefined && id !== contractId) continue;
      if (stored.claimLock !== "locked" || !stored.claimedByAuditorId || !stored.claimExpiresAt) continue;
      if (stored.claimExpiresAt.getTime() > now.getTime()) continue;
      if (this.holdsPendingFinding(id, stored.claimedByAuditorId)) continue;
      out.push({ contractId: id, auditorId: stored.claimedByAuditorId });
    }
    return out;
  }

  /** Same rule as the Postgres HOLDS_PENDING_FINDING. */
  private holdsPendingFinding(contractId: string, auditorId: string): boolean {
    const auditor = auditorId.toLowerCase();
    for (const poc of this.store.pocs.values()) {
      if (poc.auditorId.toLowerCase() !== auditor) continue;
      const finding = this.store.findings.get(poc.findingId);
      if (finding?.contractId !== contractId) continue;
      if (PENDING_STATUSES.has(finding.status)) return true;
    }
    return false;
  }

  async listPayoutsDue(now: Date): Promise<PayoutDue[]> {
    const due: PayoutDue[] = [];
    for (const record of this.store.findings.values()) {
      if (record.status !== "Verified" || this.payoutSent.has(record.id)) continue;
      if (!record.challengeWindowExpiresAt) continue;
      if (new Date(record.challengeWindowExpiresAt).getTime() > now.getTime()) continue;
      const passed = [...this.store.pocs.values()]
        .filter((poc) => poc.findingId === record.id && poc.sandboxStatus === "Passed")
        .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))[0];
      if (!passed) continue;
      due.push({ findingId: record.id, contractId: record.contractId, auditorId: passed.auditorId });
    }
    return due;
  }

  async markPayoutSent(findingId: string): Promise<void> {
    this.payoutSent.add(findingId);
  }
}
