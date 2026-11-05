import type { Bounty, Contract, ContractStatus, Wei } from "@bbm/shared";
import type { NewJob } from "../pipeline/repository.js";

export interface NewContractRecord {
  contract: Contract;
  bounty: Bounty;
  /** Queued in the same transaction so every stored contract gets analysed. */
  analysisJob: NewJob;
}

export type QueueItem = Contract & { bounty: { amount: Wei; currency: string } };

export type ClaimResult =
  | { ok: true; contract: Contract }
  | { ok: false; reason: "not_found" | "not_open" | "auditor_has_claim" };

export interface ActiveClaim {
  auditorId: string;
  expiresAt: Date;
}

/** Persistence for contracts, their bounties and their claims. Routes and
 * services depend on this interface, so the Postgres and in-memory
 * implementations stay interchangeable.
 *
 * A claim whose expiry has passed is treated as gone: the contract reads back
 * as `Open` and can be claimed again. */
export interface ContractRepository {
  /** Inserts the contract, its bounty and its analysis job together. */
  insertContract(record: NewContractRecord): Promise<void>;
  findContractById(id: string, now?: Date): Promise<Contract | null>;
  /** Newest first, optionally only one developer's (address match ignores case). */
  listContracts(filter: { developerAddress?: string }, now?: Date): Promise<Contract[]>;
  /** Atomic: of two simultaneous claims, exactly one succeeds. An auditor may
   * hold one claim at a time: the claim is refused with "auditor_has_claim"
   * while the auditor has another active claim or a claim lock state. */
  claimContract(
    contractId: string,
    auditorId: string,
    expiresAt: Date,
    now: Date,
  ): Promise<ClaimResult>;
  /** Rolls back a claim this auditor holds, reopening the contract. A no-op
   * when the auditor no longer holds it. Used when the on-chain lock fails. */
  releaseClaim(contractId: string, auditorId: string): Promise<void>;
  /** Ends `auditorId`'s claim (the contract reads Open again) only when its
   * stake lock is free or already released; a claim held by someone else, or
   * with a lock still pending or held, is left alone. */
  releaseClaimIfUnlocked(contractId: string, auditorId: string): Promise<void>;
  /** Contracts open to claim (including expired claims) whose latest analysis
   * job is done, with their bounty. `fundedOnly` keeps only bounties
   * confirmed funded on-chain. */
  listQueue(now: Date, options?: { fundedOnly?: boolean }): Promise<QueueItem[]>;
  findBounty(contractId: string): Promise<Bounty | null>;
  /** Ids of contracts the auditor holds an active claim on at `now`. */
  listClaimedContractIds(auditorId: string, now: Date): Promise<string[]>;
  /** True when the contract's latest analysis job is done. Funding and claims
   * wait for it, so a contract whose analysis failed (for example, it does
   * not compile) is never fundable or claimable. */
  isAnalysisDone(contractId: string): Promise<boolean>;
  /** True once the bounty is confirmed funded on-chain (markFunded). */
  isFunded(contractId: string): Promise<boolean>;
  /** Records that the bounty is funded on-chain. Idempotent. With `deadline`,
   * an unfunded bounty first takes that deadline (contract and bounty): funding
   * waits for the analysis, so the developer may fund with a later deadline
   * than the one entered at upload. A funded bounty keeps its deadline. */
  markFunded(contractId: string, at: Date, deadline?: Date): Promise<void>;
  /** Moves the contract through the contract status machine. Null when the
   * contract is unknown; same status is a no-op; an illegal move throws
   * InvalidTransitionError. */
  setContractStatus(contractId: string, next: ContractStatus, now?: Date): Promise<Contract | null>;
  findActiveClaim(contractId: string, now: Date): Promise<ActiveClaim | null>;
}
