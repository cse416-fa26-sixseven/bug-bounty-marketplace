import type {
  AnalysisStatus,
  Bounty,
  Contract,
  Finding,
  PoCSubmission,
  SandboxStatus,
} from "@bbm/shared";
import type { ActiveClaim } from "../contracts/repository.js";
import { compareFindings, toAnalysisJobStatus, toFinding } from "./mapping.js";
import type {
  FindingRecord,
  JobKind,
  JobStatus,
  NewAuditorFindingRecord,
  NewPocRecord,
  PipelineRepository,
  UnappliedVerdict,
} from "./repository.js";

export interface StoredContract {
  contract: Contract;
  claimedByAuditorId: string | null;
  claimExpiresAt: Date | null;
  /** Mirrors contracts.claim_lock_status: null when the claim was never locked. */
  claimLock: "locking" | "locked" | "unlocking" | "released" | null;
  /** Mirrors contracts.claim_lock_before: the lock count read before a 'locking' send. */
  claimLockBefore: bigint | null;
}

export interface StoredJob {
  id: string;
  kind: JobKind;
  subjectId: string;
  status: JobStatus;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Process-local tables shared by the in-memory repositories, used by tests
 * and by the API when no DATABASE_URL is configured. Nothing processes the
 * jobs queued here; that needs Postgres and the Python worker. */
export class MemoryStore {
  readonly contracts = new Map<string, StoredContract>();
  readonly bounties = new Map<string, Bounty>();
  /** Contract id → when its bounty was confirmed funded on-chain. */
  readonly onchainFunded = new Map<string, string>();
  readonly findings = new Map<string, FindingRecord>();
  readonly pocs = new Map<string, PoCSubmission>();
  /** PoC id → when its verdict was applied (poc_submissions.verdict_applied_at). */
  readonly verdictsApplied = new Map<string, string>();
  readonly jobs = new Map<string, StoredJob>();

  /** The contract's claim if it has not expired at `now`. */
  activeClaim(contractId: string, now: Date): ActiveClaim | null {
    const stored = this.contracts.get(contractId);
    if (!stored || stored.contract.status !== "Claimed") return null;
    if (!stored.claimedByAuditorId || !stored.claimExpiresAt) return null;
    if (stored.claimExpiresAt.getTime() <= now.getTime()) return null;
    return { auditorId: stored.claimedByAuditorId, expiresAt: new Date(stored.claimExpiresAt) };
  }

  /** The contract as callers see it at `now`: an expired claim reads as Open. */
  view(stored: StoredContract, now: Date): Contract {
    const expired =
      stored.contract.status === "Claimed" && !this.activeClaim(stored.contract.id, now);
    return { ...stored.contract, status: expired ? "Open" : stored.contract.status };
  }
}

export class MemoryPipelineRepository implements PipelineRepository {
  constructor(private readonly store: MemoryStore) {}

  async listFindings(contractId: string, now: Date): Promise<Finding[]> {
    const claim = this.store.activeClaim(contractId, now);
    return [...this.store.findings.values()]
      .filter((f) => f.contractId === contractId)
      .sort(compareFindings)
      .map((f) => toFinding(structuredClone(f), claim));
  }

  async findFinding(id: string, now: Date): Promise<(Finding & { contract: Contract }) | null> {
    const record = this.store.findings.get(id);
    const stored = record && this.store.contracts.get(record.contractId);
    if (!record || !stored) return null;
    const finding = toFinding(
      structuredClone(record),
      this.store.activeClaim(record.contractId, now),
    );
    return { ...finding, contract: this.store.view(stored, now) };
  }

  async getRawOutput(findingId: string): Promise<unknown | null> {
    const record = this.store.findings.get(findingId);
    return record ? structuredClone(record.rawOutput) : null;
  }

  async getAnalysisStatus(contractId: string): Promise<AnalysisStatus | null> {
    const latest = [...this.store.jobs.values()]
      .filter((j) => j.kind === "analysis" && j.subjectId === contractId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (!latest) return null;
    const findingCount = [...this.store.findings.values()].filter(
      (f) => f.contractId === contractId,
    ).length;
    return {
      contractId,
      status: toAnalysisJobStatus(latest.status),
      error: latest.status === "failed" ? latest.lastError : null,
      findingCount,
      updatedAt: latest.updatedAt,
    };
  }

  async submitPoc({
    poc,
    job,
    findingId,
    now,
  }: NewPocRecord): Promise<"ok" | "not_flagged" | "no_claim"> {
    const record = this.store.findings.get(findingId);
    if (!record || record.status !== "Flagged") return "not_flagged";
    const claim = this.store.activeClaim(record.contractId, new Date(now));
    if (claim?.auditorId !== poc.auditorId) return "no_claim";
    record.status = "Submitted";
    record.statusHistory = [...record.statusHistory, { status: "Submitted", changedAt: now }];
    this.store.pocs.set(poc.id, { ...poc });
    this.store.jobs.set(job.id, {
      ...job,
      status: "queued",
      attempts: 0,
      lastError: null,
      updatedAt: job.createdAt,
    });
    return "ok";
  }

  async submitAuditorFinding({
    finding,
    poc,
    job,
    now,
  }: NewAuditorFindingRecord): Promise<"ok" | "no_claim"> {
    const claim = this.store.activeClaim(finding.contractId, new Date(now));
    if (claim?.auditorId !== poc.auditorId) return "no_claim";
    this.store.findings.set(finding.id, structuredClone(finding));
    this.store.pocs.set(poc.id, { ...poc });
    this.store.jobs.set(job.id, {
      ...job,
      status: "queued",
      attempts: 0,
      lastError: null,
      updatedAt: job.createdAt,
    });
    return "ok";
  }

  async recordVerdict(pocId: string, sandboxStatus: SandboxStatus): Promise<void> {
    const poc = this.store.pocs.get(pocId);
    if (!poc) throw new Error(`Unknown PoC ${pocId}`);
    poc.sandboxStatus = sandboxStatus;
  }

  async listUnappliedVerdicts(limit: number): Promise<UnappliedVerdict[]> {
    return [...this.store.pocs.values()]
      .filter(
        (poc) =>
          (poc.sandboxStatus === "Passed" || poc.sandboxStatus === "Failed") &&
          !this.store.verdictsApplied.has(poc.id) &&
          this.store.findings.get(poc.findingId)?.status === "Submitted",
      )
      .sort((a, b) => a.submittedAt.localeCompare(b.submittedAt) || a.id.localeCompare(b.id))
      .slice(0, limit)
      .map((poc) => ({
        pocId: poc.id,
        findingId: poc.findingId,
        verdict: poc.sandboxStatus as "Passed" | "Failed",
      }));
  }

  async markVerdictApplied(pocId: string, at: Date): Promise<void> {
    if (!this.store.pocs.has(pocId)) throw new Error(`Unknown PoC ${pocId}`);
    if (!this.store.verdictsApplied.has(pocId))
      this.store.verdictsApplied.set(pocId, at.toISOString());
  }

  async markFalsePositive(findingId: string, changedAt: string): Promise<"ok" | "not_flagged" | "not_found"> {
    const record = this.store.findings.get(findingId);
    if (!record) return "not_found";
    if (record.status !== "Flagged") return "not_flagged";
    record.status = "Rejected";
    record.isFalsePositive = true;
    record.statusHistory = [...record.statusHistory, { status: "Rejected", changedAt }];
    return "ok";
  }

  async findLatestPoc(findingId: string): Promise<PoCSubmission | null> {
    const latest = [...this.store.pocs.values()]
      .filter((poc) => poc.findingId === findingId)
      .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))[0];
    return latest ? { ...latest } : null;
  }
}
