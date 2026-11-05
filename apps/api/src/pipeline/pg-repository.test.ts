import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ContractRepository } from "../contracts/repository.js";
import { PgContractRepository } from "../contracts/pg-repository.js";
import { runMigrations } from "../db/migrate.js";
import { describeRepositories, makeContract, makeFinding } from "../testing/repository-suite.js";
import type { JobStatus } from "./repository.js";
import { PgPipelineRepository } from "./pg-repository.js";

// Runs only when a Postgres instance is configured, e.g.
// DATABASE_URL=postgres://bbm:bbm@localhost:5432/bbm pnpm --filter @bbm/api test
const databaseUrl = process.env.DATABASE_URL;
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : undefined;

beforeAll(async () => {
  if (pool) await runMigrations(pool);
});

// One pool for every suite in this file; close it once they have all run.
afterAll(async () => {
  await pool?.end();
});

describeRepositories(
  "Postgres",
  () => {
    const db = pool as Pool;
    const repo = new PgContractRepository(db);
    const created: string[] = [];
    // Record every contract the tests insert so close() can remove them, keeping
    // a shared dev database free of test rows.
    const contracts: ContractRepository = {
      insertContract: async (record) => {
        created.push(record.contract.id);
        await repo.insertContract(record);
      },
      findContractById: (id, now) => repo.findContractById(id, now),
      listContracts: (filter, now) => repo.listContracts(filter, now),
      claimContract: (...args) => repo.claimContract(...args),
      releaseClaim: (id, auditorId) => repo.releaseClaim(id, auditorId),
      releaseClaimIfUnlocked: (id, auditorId) => repo.releaseClaimIfUnlocked(id, auditorId),
      listQueue: (now, options) => repo.listQueue(now, options),
      findActiveClaim: (id, now) => repo.findActiveClaim(id, now),
      findBounty: (id) => repo.findBounty(id),
      listClaimedContractIds: (id, now) => repo.listClaimedContractIds(id, now),
      markFunded: (id, at, deadline) => repo.markFunded(id, at, deadline),
      isFunded: (id) => repo.isFunded(id),
      isAnalysisDone: (id) => repo.isAnalysisDone(id),
      setContractStatus: (id, next, now) => repo.setContractStatus(id, next, now),
    };
    // Deletes every row the tests inserted so far, so a shared dev database
    // keeps no test rows.
    const purge = async () => {
      const client = await db.connect();
      await client.query("BEGIN");
      await client.query(
        `DELETE FROM jobs WHERE subject_id = ANY($1)
            OR subject_id IN (SELECT p.id FROM poc_submissions p JOIN findings f ON f.id = p.finding_id
                               WHERE f.contract_id = ANY($1))`,
        [created],
      );
      await client.query(
        "DELETE FROM poc_submissions WHERE finding_id IN (SELECT id FROM findings WHERE contract_id = ANY($1))",
        [created],
      );
      await client.query("DELETE FROM findings WHERE contract_id = ANY($1)", [created]);
      await client.query("DELETE FROM contracts WHERE id = ANY($1)", [created]);
      await client.query("DELETE FROM bounties WHERE contract_id = ANY($1)", [created]);
      await client.query("COMMIT");
      client.release();
    };
    return {
      contracts,
      pipeline: new PgPipelineRepository(db),
      seedFinding: async (f) => {
        await db.query(
          `INSERT INTO findings (id, contract_id, severity, slither_detector, slither_confidence, raw_output,
             raw_output_reference, llm_explanation, explanation_source, status, status_history,
             is_false_positive, challenge_window_expires_at, created_at,
             source, title, reported_by_auditor_id, developer_note, developer_note_updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
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
            f.developerNote,
            f.developerNoteUpdatedAt,
          ],
        );
      },
      setJobStatus: async (jobId: string, status: JobStatus, lastError?: string) => {
        await db.query("UPDATE jobs SET status = $2, last_error = $3 WHERE id = $1", [
          jobId,
          status,
          lastError ?? null,
        ]);
      },
      jobsFor: async (subjectId) => {
        const result = await db.query<{ kind: string; status: JobStatus }>(
          "SELECT kind, status FROM jobs WHERE subject_id = $1 ORDER BY created_at",
          [subjectId],
        );
        return result.rows;
      },
      reset: async () => {
        await purge();
        created.length = 0;
      },
      close: purge,
    };
  },
  { concurrent: true, skip: !pool },
);

describe.skipIf(!pool)("PgPipelineRepository ordering", () => {
  it("keeps the worker's order for findings created within the same millisecond", async () => {
    const db = pool as Pool;
    const contracts = new PgContractRepository(db);
    const record = makeContract();
    await contracts.insertContract(record);
    // The worker spaces equal-severity findings by microseconds; ids are random.
    const first = makeFinding(record.contract.id, { id: "finding_zzz_first" });
    const second = makeFinding(record.contract.id, { id: "finding_aaa_second" });
    for (const [finding, at] of [
      [first, "2026-10-20T12:00:00.000001Z"],
      [second, "2026-10-20T12:00:00.000002Z"],
    ] as const) {
      await db.query(
        `INSERT INTO findings (id, contract_id, severity, slither_detector, slither_confidence, raw_output,
           raw_output_reference, llm_explanation, explanation_source, status, status_history, created_at)
         VALUES ($1, $2, 'Low', 'x', 'High', '{}', $3, 'e', 'slither', 'Flagged', '[]', $4)`,
        [finding.id, record.contract.id, finding.rawOutputReference, at],
      );
    }
    try {
      const listed = await new PgPipelineRepository(db).listFindings(
        record.contract.id,
        new Date(),
      );
      expect(listed.map((f) => f.id)).toEqual([first.id, second.id]);
    } finally {
      await db.query("DELETE FROM findings WHERE contract_id = $1", [record.contract.id]);
      await db.query("DELETE FROM jobs WHERE subject_id = $1", [record.contract.id]);
      await db.query("DELETE FROM contracts WHERE id = $1", [record.contract.id]);
      await db.query("DELETE FROM bounties WHERE id = $1", [record.bounty.id]);
    }
  });
});
