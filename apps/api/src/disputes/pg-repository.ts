import type { Pool } from "pg";
import type { Dispute, DisputeRuling } from "@bbm/shared";
import type { DisputeRepository, LapseCandidate } from "./repository.js";

interface DisputeRow {
  id: string;
  finding_id: string;
  developer_id: string;
  reason: string;
  opened_at: Date;
  challenge_window_expires_at: Date | null;
  ruling: DisputeRuling;
  ruled_at: Date | null;
  arbiter_id: string | null;
}

const COLUMNS =
  "id, finding_id, developer_id, reason, opened_at, challenge_window_expires_at, ruling, ruled_at, arbiter_id";

function toDispute(row: DisputeRow): Dispute {
  return {
    id: row.id,
    findingId: row.finding_id,
    developerId: row.developer_id,
    reason: row.reason,
    openedAt: row.opened_at.toISOString(),
    challengeWindowExpiresAt: (row.challenge_window_expires_at ?? row.opened_at).toISOString(),
    ruling: row.ruling,
    ruledAt: row.ruled_at?.toISOString() ?? null,
    arbiterId: row.arbiter_id,
  };
}

/** Postgres DisputeRepository over the `disputes` table (migration 0007). */
export class PgDisputeRepository implements DisputeRepository {
  constructor(private readonly pool: Pool) {}

  async create(d: Dispute & { contractId: string; ruleBy?: Date }): Promise<Dispute> {
    await this.pool.query(
      `INSERT INTO disputes (id, finding_id, contract_id, developer_id, reason, opened_at, challenge_window_expires_at, ruling, rule_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'Pending', $8)
       ON CONFLICT (finding_id) DO NOTHING`,
      [
        d.id, d.findingId, d.contractId, d.developerId, d.reason, d.openedAt,
        d.challengeWindowExpiresAt, d.ruleBy ?? null,
      ],
    );
    return (await this.findByFinding(d.findingId))!;
  }

  async listLapseCandidates(cutoff: Date): Promise<LapseCandidate[]> {
    const result = await this.pool.query<{
      id: string;
      finding_id: string;
      contract_id: string;
      rule_by: Date | null;
    }>(
      `SELECT id, finding_id, contract_id, rule_by FROM disputes
        WHERE ruling = 'Pending' AND (rule_by IS NULL OR rule_by < $1)
        ORDER BY opened_at`,
      [cutoff],
    );
    return result.rows.map((row) => ({
      id: row.id,
      findingId: row.finding_id,
      contractId: row.contract_id,
      ruleBy: row.rule_by,
    }));
  }

  async setRuleBy(id: string, ruleBy: Date): Promise<void> {
    await this.pool.query("UPDATE disputes SET rule_by = $2 WHERE id = $1", [id, ruleBy]);
  }

  async findById(id: string): Promise<Dispute | null> {
    const result = await this.pool.query<DisputeRow>(`SELECT ${COLUMNS} FROM disputes WHERE id = $1`, [id]);
    return result.rows[0] ? toDispute(result.rows[0]) : null;
  }

  async findByFinding(findingId: string): Promise<Dispute | null> {
    const result = await this.pool.query<DisputeRow>(`SELECT ${COLUMNS} FROM disputes WHERE finding_id = $1`, [findingId]);
    return result.rows[0] ? toDispute(result.rows[0]) : null;
  }

  async list(ruling?: DisputeRuling): Promise<Dispute[]> {
    const result = await this.pool.query<DisputeRow>(
      `SELECT ${COLUMNS} FROM disputes WHERE ($1::text IS NULL OR ruling = $1) ORDER BY opened_at DESC`,
      [ruling ?? null],
    );
    return result.rows.map(toDispute);
  }

  async setRuling(id: string, ruling: Exclude<DisputeRuling, "Pending">, arbiterId: string, at: Date): Promise<Dispute | null> {
    const result = await this.pool.query<DisputeRow>(
      `UPDATE disputes SET ruling = $2, arbiter_id = $3, ruled_at = $4
        WHERE id = $1 AND ruling = 'Pending' RETURNING ${COLUMNS}`,
      [id, ruling, arbiterId, at],
    );
    return result.rows[0] ? toDispute(result.rows[0]) : null;
  }
}
