import type { Dispute, DisputeRuling } from "@bbm/shared";

/** A Pending dispute as the lapse keeper needs it. */
export interface LapseCandidate {
  id: string;
  findingId: string;
  contractId: string;
  /** When the arbiter's ruling window closes; null when not recorded yet. */
  ruleBy: Date | null;
}

/** Disputes mirrored from DisputeResolution: one per finding. */
export interface DisputeRepository {
  /** Inserts the dispute unless the finding already has one; returns the
   * stored one. `ruleBy` is the on-chain end of the ruling window. */
  create(dispute: Dispute & { contractId: string; ruleBy?: Date }): Promise<Dispute>;
  /** Pending disputes whose ruling window closed before `cutoff`, plus those
   * with no ruling window recorded yet. */
  listLapseCandidates(cutoff: Date): Promise<LapseCandidate[]>;
  /** Records the on-chain end of a dispute's ruling window. */
  setRuleBy(id: string, ruleBy: Date): Promise<void>;
  findById(id: string): Promise<Dispute | null>;
  findByFinding(findingId: string): Promise<Dispute | null>;
  list(ruling?: DisputeRuling): Promise<Dispute[]>;
  /** Sets the ruling of a Pending dispute; null when it was already ruled. */
  setRuling(id: string, ruling: Exclude<DisputeRuling, "Pending">, arbiterId: string, at: Date): Promise<Dispute | null>;
}
