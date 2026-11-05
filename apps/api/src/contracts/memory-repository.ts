import type { Bounty, Contract, ContractStatus } from "@bbm/shared";
import { InvalidTransitionError, canTransitionContract } from "../status/transitions.js";
import { MemoryStore } from "../pipeline/memory-repository.js";
import type {
  ActiveClaim,
  ClaimResult,
  ContractRepository,
  NewContractRecord,
  QueueItem,
} from "./repository.js";

/** Process-local repository used by tests and by the API when no DATABASE_URL
 * is configured. Data does not survive a restart. Pass the same MemoryStore
 * to MemoryPipelineRepository so both see the same rows. */
/** Claim lock states that keep the holder's stake locked on-chain. */
const HELD_LOCK_STATES = new Set(["locking", "locked", "unlocking"]);

/** A claim may be made only when no lock state is pending on the contract. */
function lockIsFree(claimLock: string | null): boolean {
  return claimLock === null || claimLock === "released";
}

export class MemoryContractRepository implements ContractRepository {
  constructor(private readonly store: MemoryStore = new MemoryStore()) {}

  async insertContract({ contract, bounty, analysisJob }: NewContractRecord): Promise<void> {
    if (this.store.contracts.has(contract.id)) {
      throw new Error(`Contract ${contract.id} already exists`);
    }
    this.store.contracts.set(contract.id, {
      contract: { ...contract },
      claimedByAuditorId: null,
      claimExpiresAt: null,
      claimLock: null,
      claimLockBefore: null,
    });
    this.store.bounties.set(bounty.id, { ...bounty });
    this.store.jobs.set(analysisJob.id, {
      ...analysisJob,
      status: "queued",
      attempts: 0,
      lastError: null,
      updatedAt: analysisJob.createdAt,
    });
  }

  async findContractById(id: string, now: Date = new Date()): Promise<Contract | null> {
    const stored = this.store.contracts.get(id);
    return stored ? this.store.view(stored, now) : null;
  }

  async listContracts(
    filter: { developerAddress?: string },
    now: Date = new Date(),
  ): Promise<Contract[]> {
    const wanted = filter.developerAddress?.toLowerCase();
    return [...this.store.contracts.values()]
      .filter((s) => !wanted || s.contract.developerAddress.toLowerCase() === wanted)
      .sort((a, b) => b.contract.createdAt.localeCompare(a.contract.createdAt))
      .map((s) => this.store.view(s, now));
  }

  async claimContract(
    contractId: string,
    auditorId: string,
    expiresAt: Date,
    now: Date,
  ): Promise<ClaimResult> {
    const stored = this.store.contracts.get(contractId);
    if (!stored) return { ok: false, reason: "not_found" };
    if (this.store.view(stored, now).status !== "Open" || !lockIsFree(stored.claimLock)) {
      return { ok: false, reason: "not_open" };
    }
    if (this.holdsAnotherClaim(contractId, auditorId, now)) {
      return { ok: false, reason: "auditor_has_claim" };
    }
    stored.contract.status = "Claimed";
    stored.claimedByAuditorId = auditorId;
    stored.claimExpiresAt = new Date(expiresAt);
    stored.claimLock = null;
    stored.claimLockBefore = null;
    return { ok: true, contract: { ...stored.contract } };
  }

  /** True when the auditor holds an active claim, or a claim with a lock state,
   * on a contract other than `contractId`. Same rule as the Postgres claim. */
  private holdsAnotherClaim(contractId: string, auditorId: string, now: Date): boolean {
    for (const [id, other] of this.store.contracts) {
      if (id === contractId || other.claimedByAuditorId !== auditorId) continue;
      if (other.claimLock !== null && HELD_LOCK_STATES.has(other.claimLock)) return true;
      if (this.store.view(other, now).status === "Claimed") return true;
    }
    return false;
  }

  async releaseClaim(contractId: string, auditorId: string): Promise<void> {
    const stored = this.store.contracts.get(contractId);
    if (!stored || stored.claimedByAuditorId !== auditorId) return;
    stored.contract.status = "Open";
    stored.claimExpiresAt = null;
    // A pending lock or unlock keeps the holder and the state, as in the Postgres
    // repository: the sweep needs both to finish it after the claim is rolled back.
    if (stored.claimLock !== "locking" && stored.claimLock !== "unlocking") {
      stored.claimedByAuditorId = null;
      stored.claimLock = null;
      stored.claimLockBefore = null;
    }
  }

  async releaseClaimIfUnlocked(contractId: string, auditorId: string): Promise<void> {
    const stored = this.store.contracts.get(contractId);
    if (!stored || stored.contract.status !== "Claimed" || !lockIsFree(stored.claimLock)) return;
    if (stored.claimedByAuditorId?.toLowerCase() !== auditorId.toLowerCase()) return;
    stored.contract.status = "Open";
    stored.claimExpiresAt = null;
    stored.claimedByAuditorId = null;
    stored.claimLock = null;
    stored.claimLockBefore = null;
  }

  async listQueue(now: Date, options: { fundedOnly?: boolean } = {}): Promise<QueueItem[]> {
    const items: QueueItem[] = [];
    for (const stored of this.store.contracts.values()) {
      const contract = this.store.view(stored, now);
      if (contract.status !== "Open" || !lockIsFree(stored.claimLock)) continue;
      if (options.fundedOnly && !this.store.onchainFunded.has(contract.id)) continue;
      if (!this.analysisDone(contract.id)) continue;
      const bounty = this.store.bounties.get(contract.bountyId);
      items.push({
        ...contract,
        bounty: { amount: bounty?.amount ?? "0", currency: bounty?.currency ?? "ETH" },
      });
    }
    return items;
  }

  async isAnalysisDone(contractId: string): Promise<boolean> {
    return this.analysisDone(contractId);
  }

  /** Same rule as the Postgres LATEST_ANALYSIS_DONE: the newest analysis job is done. */
  private analysisDone(contractId: string): boolean {
    const latest = [...this.store.jobs.values()]
      .filter((j) => j.kind === "analysis" && j.subjectId === contractId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0];
    return latest?.status === "done";
  }

  async findActiveClaim(contractId: string, now: Date): Promise<ActiveClaim | null> {
    return this.store.activeClaim(contractId, now);
  }

  async findBounty(contractId: string): Promise<Bounty | null> {
    const stored = this.store.contracts.get(contractId);
    return stored ? (this.store.bounties.get(stored.contract.bountyId) ?? null) : null;
  }

  async listClaimedContractIds(auditorId: string, now: Date): Promise<string[]> {
    return [...this.store.contracts.values()]
      .filter((stored) => this.store.activeClaim(stored.contract.id, now)?.auditorId === auditorId)
      .map((stored) => stored.contract.id);
  }

  async isFunded(contractId: string): Promise<boolean> {
    return this.store.onchainFunded.has(contractId);
  }

  async markFunded(contractId: string, at: Date): Promise<void> {
    if (!this.store.onchainFunded.has(contractId))
      this.store.onchainFunded.set(contractId, at.toISOString());
  }

  async setContractStatus(
    contractId: string,
    next: ContractStatus,
    now: Date = new Date(),
  ): Promise<Contract | null> {
    const stored = this.store.contracts.get(contractId);
    if (!stored) return null;
    const current = this.store.view(stored, now).status;
    if (current === next) return this.store.view(stored, now);
    if (!canTransitionContract(current, next))
      throw new InvalidTransitionError("contract", current, next);
    stored.contract = { ...stored.contract, status: next };
    // A held lock keeps its holder and expiry, so the unlock sweep can still
    // release the auditor's stake.
    if (next !== "Claimed" && !HELD_LOCK_STATES.has(stored.claimLock ?? "")) {
      stored.claimedByAuditorId = null;
      stored.claimExpiresAt = null;
    }
    return this.store.view(stored, now);
  }
}
