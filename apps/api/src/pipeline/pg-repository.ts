import type { Pool, PoolClient } from "pg";
import type { AnalysisStatus, Contract, Finding, PoCSubmission, SandboxStatus } from "@bbm/shared";
import { PgContractRepository } from "../contracts/pg-repository.js";
import { toAnalysisJobStatus, toFinding } from "./mapping.js";
import type {
  FindingRecord,
  JobStatus,
  NewJob,
  NewAuditorFindingRecord,
  NewPocRecord,
  PipelineRepository,
  UnappliedVerdict,
} from "./repository.js";

interface FindingRow {
  id: string;
  contract_id: string;
  severity: FindingRecord["severity"];
  slither_detector: string;
  slither_confidence: string;
  raw_output_reference: string;
  llm_explanation: string;
  explanation_source: FindingRecord["explanationSource"];
  status: FindingRecord["status"];
  status_history: FindingRecord["statusHistory"];
  is_false_positive: boolean;
  challenge_window_expires_at: Date | null;
  created_at: Date;
  source: FindingRecord["source"];
  title: string | null;
  reported_by_auditor_id: string | null;
}

const FINDING_COLUMNS = `id, contract_id, severity, slither_detector, slither_confidence,
  raw_output_reference, llm_explanation, explanation_source, status, status_history,
  is_false_positive, challenge_window_expires_at, created_at, source, title, reported_by_auditor_id`;

/** Raw output is fetched separately (GET /api/findings/:id/raw), so list
 * queries leave the JSONB column out. */
function toRecord(row: FindingRow): FindingRecord {
  return {
    id: row.id,
    contractId: row.contract_id,
    severity: row.severity,
    slitherDetector: row.slither_detector,
    slitherConfidence: row.slither_confidence,
    rawOutput: null,
    rawOutputReference: row.raw_output_reference,
    llmExplanation: row.llm_explanation,
    explanationSource: row.explanation_source,
    status: row.status,
    statusHistory: row.status_history,
    isFalsePositive: row.is_false_positive,
    challengeWindowExpiresAt: row.challenge_window_expires_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    source: row.source,
    title: row.title,
    reportedByAuditorId: row.reported_by_auditor_id,
  };
}

/** Writes a PoC row and its queued sandbox job, inside the caller's transaction. */
async function insertPocAndJob(client: PoolClient, poc: PoCSubmission, job: NewJob): Promise<void> {
  await client.query(
    `INSERT INTO poc_submissions
       (id, finding_id, auditor_id, test_file_reference, submitted_at, sandbox_status, sandbox_log)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      poc.id,
      poc.findingId,
      poc.auditorId,
      poc.testFileReference,
      poc.submittedAt,
      poc.sandboxStatus,
      poc.sandboxLog,
    ],
  );
  await client.query(
    `INSERT INTO jobs (id, kind, subject_id, status, attempts, created_at, updated_at)
     VALUES ($1, $2, $3, 'queued', 0, $4, $4)`,
    [job.id, job.kind, job.subjectId, job.createdAt],
  );
}

export class PgPipelineRepository implements PipelineRepository {
  private readonly contracts: PgContractRepository;

  constructor(private readonly pool: Pool) {
    this.contracts = new PgContractRepository(pool);
  }

  async listFindings(contractId: string, now: Date): Promise<Finding[]> {
    const [result, claim] = await Promise.all([
      // Ordered in SQL: created_at keeps the microseconds the worker uses to
      // preserve Slither's order, which toISOString() would drop.
      this.pool.query<FindingRow>(
        `SELECT ${FINDING_COLUMNS} FROM findings WHERE contract_id = $1
          ORDER BY array_position(ARRAY['Critical','High','Medium','Low','Informational'], severity),
                   created_at, id`,
        [contractId],
      ),
      this.contracts.findActiveClaim(contractId, now),
    ]);
    return result.rows.map(toRecord).map((record) => toFinding(record, claim));
  }

  async findFinding(id: string, now: Date): Promise<(Finding & { contract: Contract }) | null> {
    const result = await this.pool.query<FindingRow>(
      `SELECT ${FINDING_COLUMNS} FROM findings WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    if (!row) return null;
    const [contract, claim] = await Promise.all([
      this.contracts.findContractById(row.contract_id, now),
      this.contracts.findActiveClaim(row.contract_id, now),
    ]);
    if (!contract) return null;
    return { ...toFinding(toRecord(row), claim), contract };
  }

  async getRawOutput(findingId: string): Promise<unknown | null> {
    const result = await this.pool.query<{ raw_output: unknown }>(
      "SELECT raw_output FROM findings WHERE id = $1",
      [findingId],
    );
    return result.rows[0]?.raw_output ?? null;
  }

  async getAnalysisStatus(contractId: string): Promise<AnalysisStatus | null> {
    const result = await this.pool.query<{
      status: JobStatus;
      last_error: string | null;
      updated_at: Date;
      finding_count: string;
    }>(
      `SELECT j.status, j.last_error, j.updated_at,
              (SELECT count(*) FROM findings f WHERE f.contract_id = $1) AS finding_count
         FROM jobs j
        WHERE j.kind = 'analysis' AND j.subject_id = $1
        ORDER BY j.created_at DESC, j.id DESC
        LIMIT 1`,
      [contractId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      contractId,
      status: toAnalysisJobStatus(row.status),
      error: row.status === "failed" ? row.last_error : null,
      findingCount: Number(row.finding_count),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  async submitPoc({
    poc,
    job,
    findingId,
    now,
  }: NewPocRecord): Promise<"ok" | "not_flagged" | "no_claim"> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query(
        `UPDATE findings
            SET status = 'Submitted', status_history = status_history || $2::jsonb
          WHERE id = $1 AND status = 'Flagged'
            AND EXISTS (
              SELECT 1 FROM contracts c
               WHERE c.id = findings.contract_id AND c.status = 'Claimed'
                 AND c.claimed_by_auditor_id = $3 AND c.claim_expires_at > $4)`,
        [findingId, JSON.stringify([{ status: "Submitted", changedAt: now }]), poc.auditorId, now],
      );
      if (updated.rowCount !== 1) {
        const current = await client.query<{ status: string }>(
          "SELECT status FROM findings WHERE id = $1",
          [findingId],
        );
        await client.query("ROLLBACK");
        return current.rows[0]?.status === "Flagged" ? "no_claim" : "not_flagged";
      }
      await insertPocAndJob(client, poc, job);
      await client.query("COMMIT");
      return "ok";
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async submitAuditorFinding({
    finding: f,
    poc,
    job,
    now,
  }: NewAuditorFindingRecord): Promise<"ok" | "no_claim"> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // The claim check holds a share lock on the contract row until commit,
      // so the claim cannot be released or replaced between the check and
      // the inserts.
      const claimed = await client.query(
        `SELECT 1 FROM contracts
          WHERE id = $1 AND status = 'Claimed'
            AND claimed_by_auditor_id = $2 AND claim_expires_at > $3
          FOR SHARE`,
        [f.contractId, poc.auditorId, now],
      );
      if (claimed.rowCount !== 1) {
        await client.query("ROLLBACK");
        return "no_claim";
      }
      await client.query(
        `INSERT INTO findings (id, contract_id, severity, slither_detector, slither_confidence,
           raw_output, raw_output_reference, llm_explanation, explanation_source, status,
           status_history, is_false_positive, challenge_window_expires_at, created_at,
           source, title, reported_by_auditor_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
        [
          f.id,
          f.contractId,
          f.severity,
          f.slitherDetector,
          f.slitherConfidence,
          JSON.stringify(f.rawOutput),
          f.rawOutputReference,
          f.llmExplanation,
          f.explanationSource,
          f.status,
          JSON.stringify(f.statusHistory),
          f.isFalsePositive,
          f.challengeWindowExpiresAt,
          f.createdAt,
          f.source,
          f.title,
          f.reportedByAuditorId,
        ],
      );
      await insertPocAndJob(client, poc, job);
      await client.query("COMMIT");
      return "ok";
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async recordVerdict(pocId: string, sandboxStatus: SandboxStatus): Promise<void> {
    const result = await this.pool.query(
      "UPDATE poc_submissions SET sandbox_status = $2 WHERE id = $1",
      [pocId, sandboxStatus],
    );
    if (result.rowCount !== 1) throw new Error(`Unknown PoC ${pocId}`);
  }

  async listUnappliedVerdicts(limit: number): Promise<UnappliedVerdict[]> {
    const result = await this.pool.query<{
      id: string;
      finding_id: string;
      sandbox_status: "Passed" | "Failed";
    }>(
      `SELECT p.id, p.finding_id, p.sandbox_status
         FROM poc_submissions p
         JOIN findings f ON f.id = p.finding_id
        WHERE p.sandbox_status IN ('Passed', 'Failed')
          AND p.verdict_applied_at IS NULL
          AND f.status = 'Submitted'
        ORDER BY p.submitted_at, p.id
        LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => ({
      pocId: row.id,
      findingId: row.finding_id,
      verdict: row.sandbox_status,
    }));
  }

  async markVerdictApplied(pocId: string, at: Date): Promise<void> {
    const result = await this.pool.query(
      "UPDATE poc_submissions SET verdict_applied_at = COALESCE(verdict_applied_at, $2) WHERE id = $1",
      [pocId, at],
    );
    if (result.rowCount !== 1) throw new Error(`Unknown PoC ${pocId}`);
  }

  async markFalsePositive(findingId: string, changedAt: string): Promise<"ok" | "not_flagged" | "not_found"> {
    const result = await this.pool.query(
      `UPDATE findings
          SET status = 'Rejected', is_false_positive = true,
              status_history = status_history || $2::jsonb
        WHERE id = $1 AND status = 'Flagged'`,
      [findingId, JSON.stringify([{ status: "Rejected", changedAt }])],
    );
    if (result.rowCount === 1) return "ok";
    const exists = await this.pool.query("SELECT 1 FROM findings WHERE id = $1", [findingId]);
    return exists.rowCount === 1 ? "not_flagged" : "not_found";
  }

  async findLatestPoc(findingId: string): Promise<PoCSubmission | null> {
    const result = await this.pool.query<{
      id: string;
      finding_id: string;
      auditor_id: string;
      test_file_reference: string;
      submitted_at: Date;
      sandbox_status: PoCSubmission["sandboxStatus"];
      sandbox_log: string | null;
    }>(
      `SELECT id, finding_id, auditor_id, test_file_reference, submitted_at, sandbox_status, sandbox_log
         FROM poc_submissions WHERE finding_id = $1 ORDER BY submitted_at DESC, id DESC LIMIT 1`,
      [findingId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      findingId: row.finding_id,
      auditorId: row.auditor_id,
      testFileReference: row.test_file_reference,
      submittedAt: row.submitted_at.toISOString(),
      sandboxStatus: row.sandbox_status,
      sandboxLog: row.sandbox_log,
    };
  }
}
