import type { AnalysisJobStatus, Finding, FindingSeverity } from "@bbm/shared";
import type { ActiveClaim } from "../contracts/repository.js";
import type { FindingRecord, JobStatus } from "./repository.js";

const SEVERITY_RANK: Record<FindingSeverity, number> = {
  Critical: 0,
  High: 1,
  Medium: 2,
  Low: 3,
  Informational: 4,
};

/** Sort order for findings: most severe first, then oldest, then by id. */
export function compareFindings(a: FindingRecord, b: FindingRecord): number {
  return (
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
    a.createdAt.localeCompare(b.createdAt) ||
    a.id.localeCompare(b.id)
  );
}

/** Maps a stored finding onto the shared schema. The claim fields come from
 * the contract's active claim; internal columns are dropped. */
export function toFinding(record: FindingRecord, claim: ActiveClaim | null): Finding {
  return {
    id: record.id,
    contractId: record.contractId,
    severity: record.severity,
    slitherDetector: record.slitherDetector,
    rawOutputReference: record.rawOutputReference,
    llmExplanation: record.llmExplanation,
    status: record.status,
    statusHistory: record.statusHistory,
    claimedByAuditorId: claim?.auditorId ?? null,
    claimExpiresAt: claim ? claim.expiresAt.toISOString() : null,
    isFalsePositive: record.isFalsePositive,
    challengeWindowExpiresAt: record.challengeWindowExpiresAt,
    source: record.source,
    title: record.title,
    reportedByAuditorId: record.reportedByAuditorId,
    developerNote: record.developerNote,
    developerNoteUpdatedAt: record.developerNoteUpdatedAt,
  };
}

const JOB_STATUS: Record<JobStatus, AnalysisJobStatus> = {
  queued: "Queued",
  running: "Running",
  done: "Done",
  failed: "Failed",
};

export function toAnalysisJobStatus(status: JobStatus): AnalysisJobStatus {
  return JOB_STATUS[status];
}
