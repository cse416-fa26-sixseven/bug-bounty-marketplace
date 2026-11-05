import type { Pool } from "pg";
import type { FindingStatus } from "@bbm/shared";
import type { ChainActionStore, ChainActionStoreOptions, FindingChainRef, PayoutDue } from "./action-store.js";
import { DEFAULT_CHALLENGE_WINDOW_SECONDS, challengeWindowEnd } from "./action-store.js";
import { FINDING_TRANSITIONS, InvalidTransitionError, canTransitionFinding } from "../status/transitions.js";

/** True when the claim on `contracts` backs a finding still waiting on its
 * verdict, payout or dispute. The expiry sweep must not unlock that stake. */
const HOLDS_PENDING_FINDING = `EXISTS (
  SELECT 1 FROM findings f JOIN poc_submissions p ON p.finding_id = f.id
   WHERE f.contract_id = contracts.id
     AND lower(p.auditor_id) = lower(contracts.claimed_by_auditor_id)
     AND f.status IN ('Submitted', 'Verified', 'Disputed'))`;

/** Postgres ChainActionStore. Columns come from db/migrations/0005_claim_locks.sql. */
export class PgChainActionStore implements ChainActionStore {
  private readonly challengeWindowSeconds: number;

  constructor(
    private readonly pool: Pool,
    options: ChainActionStoreOptions = {},
  ) {
    this.challengeWindowSeconds = options.challengeWindowSeconds ?? DEFAULT_CHALLENGE_WINDOW_SECONDS;
  }

  async getFindingStatus(findingId: string): Promise<FindingStatus | null> {
    const result = await this.pool.query<{ status: FindingStatus }>(
      "SELECT status FROM findings WHERE id = $1",
      [findingId],
    );
    return result.rows[0]?.status ?? null;
  }

  /**
   * Moves the finding only from a status the status machine allows, in one
   * guarded UPDATE, so a concurrent writer (the indexer, a route, the verdict
   * loop) cannot be overwritten. Writing the current status again is a no-op.
   * Verified also opens the challenge window; Paid also resolves the contract.
   */
  async setFindingStatus(findingId: string, status: FindingStatus, changedAt: string): Promise<void> {
    const predecessors = (Object.keys(FINDING_TRANSITIONS) as FindingStatus[]).filter((from) => canTransitionFinding(from, status));
    const windowEnd = status === "Verified" ? challengeWindowEnd(changedAt, this.challengeWindowSeconds) : null;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{ contract_id: string }>(
        `UPDATE findings
            SET status = $2,
                status_history = status_history || $3::jsonb,
                challenge_window_expires_at = CASE WHEN $2 = 'Verified' THEN $5::timestamptz
                                                   ELSE challenge_window_expires_at END
          WHERE id = $1 AND status = ANY($4::text[])
          RETURNING contract_id`,
        [findingId, status, JSON.stringify([{ status, changedAt }]), predecessors, windowEnd],
      );
      if (result.rowCount === 1) {
        if (status === "Paid") {
          await client.query("UPDATE contracts SET status = 'Resolved' WHERE id = $1 AND status IN ('Open', 'Claimed')", [
            result.rows[0]!.contract_id,
          ]);
        }
        await client.query("COMMIT");
        return;
      }
      await client.query("ROLLBACK");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    const current = await this.getFindingStatus(findingId);
    if (current === null) throw new Error(`Finding not found: ${findingId}`);
    if (current === status) return;
    throw new InvalidTransitionError("finding", current, status);
  }

  async findFinding(findingId: string): Promise<FindingChainRef | null> {
    const result = await this.pool.query<{
      id: string;
      contract_id: string;
      status: FindingStatus;
      verification_recorded_at: Date | null;
      auditor_id: string | null;
    }>(
      `SELECT f.id, f.contract_id, f.status, f.verification_recorded_at,
              (SELECT p.auditor_id FROM poc_submissions p
                WHERE p.finding_id = f.id
                ORDER BY p.submitted_at DESC, p.id DESC LIMIT 1) AS auditor_id
         FROM findings f
        WHERE f.id = $1`,
      [findingId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      findingId: row.id,
      contractId: row.contract_id,
      status: row.status,
      auditorId: row.auditor_id,
      verificationRecorded: row.verification_recorded_at !== null,
    };
  }

  async isSubmissionRecorded(contractId: string): Promise<boolean> {
    const result = await this.pool.query<{ recorded: boolean }>(
      "SELECT submission_recorded_at IS NOT NULL AS recorded FROM contracts WHERE id = $1",
      [contractId],
    );
    return result.rows[0]?.recorded ?? false;
  }

  async markSubmissionRecorded(contractId: string, at: Date): Promise<void> {
    await this.pool.query(
      "UPDATE contracts SET submission_recorded_at = $2 WHERE id = $1 AND submission_recorded_at IS NULL",
      [contractId, at],
    );
  }

  async markVerificationRecorded(findingId: string, at: Date): Promise<void> {
    await this.pool.query(
      "UPDATE findings SET verification_recorded_at = $2 WHERE id = $1 AND verification_recorded_at IS NULL",
      [findingId, at],
    );
  }

  async markClaimLocking(contractId: string, auditorId: string, before: bigint): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE contracts SET claim_lock_status = 'locking', claim_lock_before = $3
        WHERE id = $1 AND status = 'Claimed' AND claimed_by_auditor_id = $2
          AND claim_lock_status IS NULL`,
      [contractId, auditorId, before.toString()],
    );
    return result.rowCount === 1;
  }

  async clearClaimLocking(contractId: string, auditorId: string): Promise<void> {
    // An Open contract keeps no holder once its intent is cleared.
    await this.pool.query(
      `UPDATE contracts
          SET claim_lock_status = NULL, claim_lock_before = NULL,
              claimed_by_auditor_id = CASE WHEN status = 'Claimed'
                                           THEN claimed_by_auditor_id END
        WHERE id = $1 AND claim_lock_status = 'locking' AND claimed_by_auditor_id = $2`,
      [contractId, auditorId],
    );
  }

  async findLockingClaims(
    contractId?: string,
  ): Promise<{ contractId: string; auditorId: string; lockBefore: bigint | null }[]> {
    const result = await this.pool.query<{
      id: string;
      claimed_by_auditor_id: string;
      claim_lock_before: string | null;
    }>(
      `SELECT id, claimed_by_auditor_id, claim_lock_before FROM contracts
        WHERE claim_lock_status = 'locking'
          AND claimed_by_auditor_id IS NOT NULL
          AND ($1::text IS NULL OR id = $1)
        ORDER BY id`,
      [contractId ?? null],
    );
    return result.rows.map((row) => ({
      contractId: row.id,
      auditorId: row.claimed_by_auditor_id,
      lockBefore: row.claim_lock_before === null ? null : BigInt(row.claim_lock_before),
    }));
  }

  async markClaimLocked(contractId: string, auditorId: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE contracts SET claim_lock_status = 'locked', claim_lock_before = NULL
        WHERE id = $1 AND status = 'Claimed' AND claimed_by_auditor_id = $2
          AND claim_lock_status = 'locking'`,
      [contractId, auditorId],
    );
    return result.rowCount === 1;
  }

  async takeClaimUnlock(
    contractId: string,
    options: { auditorId?: string; expiredBy?: Date },
  ): Promise<string | null> {
    // One UPDATE decides the race: of two concurrent takes, only the one
    // that still sees 'locked' on the row gets a row back.
    const result = await this.pool.query<{ claimed_by_auditor_id: string }>(
      `UPDATE contracts SET claim_lock_status = 'unlocking'
        WHERE id = $1
          AND claim_lock_status = 'locked'
          AND ($2::text IS NULL OR claimed_by_auditor_id = $2)
          AND ($3::timestamptz IS NULL OR (claim_expires_at <= $3 AND NOT ${HOLDS_PENDING_FINDING}))
        RETURNING claimed_by_auditor_id`,
      [contractId, options.auditorId ?? null, options.expiredBy ?? null],
    );
    return result.rows[0]?.claimed_by_auditor_id ?? null;
  }

  async findUnlockingClaims(contractId?: string): Promise<{ contractId: string; auditorId: string }[]> {
    const result = await this.pool.query<{ id: string; claimed_by_auditor_id: string }>(
      `SELECT id, claimed_by_auditor_id FROM contracts
        WHERE claim_lock_status = 'unlocking'
          AND claimed_by_auditor_id IS NOT NULL
          AND ($1::text IS NULL OR id = $1)
        ORDER BY id`,
      [contractId ?? null],
    );
    return result.rows.map((row) => ({ contractId: row.id, auditorId: row.claimed_by_auditor_id }));
  }

  async markClaimUnlocking(contractId: string, auditorId: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE contracts SET claim_lock_status = 'unlocking', claim_lock_before = NULL
        WHERE id = $1 AND claimed_by_auditor_id = $2`,
      [contractId, auditorId],
    );
    return result.rowCount === 1;
  }

  async markClaimReleased(contractId: string, auditorId: string): Promise<void> {
    await this.pool.query(
      `UPDATE contracts SET claim_lock_status = 'released'
        WHERE id = $1 AND claim_lock_status = 'unlocking' AND claimed_by_auditor_id = $2`,
      [contractId, auditorId],
    );
  }

  async listExpiredLockedClaims(
    now: Date,
    contractId?: string,
  ): Promise<{ contractId: string; auditorId: string }[]> {
    const result = await this.pool.query<{ id: string; claimed_by_auditor_id: string }>(
      `SELECT id, claimed_by_auditor_id FROM contracts
        WHERE claim_lock_status = 'locked'
          AND claim_expires_at <= $1
          AND NOT ${HOLDS_PENDING_FINDING}
          AND ($2::text IS NULL OR id = $2)
        ORDER BY id`,
      [now, contractId ?? null],
    );
    return result.rows.map((row) => ({ contractId: row.id, auditorId: row.claimed_by_auditor_id }));
  }

  async listPayoutsDue(now: Date): Promise<PayoutDue[]> {
    const result = await this.pool.query<{ finding_id: string; contract_id: string; auditor_id: string }>(
      `SELECT f.id AS finding_id, f.contract_id, p.auditor_id
         FROM findings f
         JOIN LATERAL (
           SELECT auditor_id FROM poc_submissions
            WHERE finding_id = f.id AND sandbox_status = 'Passed'
            ORDER BY submitted_at DESC, id DESC
            LIMIT 1
         ) p ON true
        WHERE f.status = 'Verified'
          AND f.challenge_window_expires_at <= $1
          AND f.payout_sent_at IS NULL
        ORDER BY f.challenge_window_expires_at, f.id`,
      [now],
    );
    return result.rows.map((row) => ({
      findingId: row.finding_id,
      contractId: row.contract_id,
      auditorId: row.auditor_id,
    }));
  }

  async markPayoutSent(findingId: string, at: Date): Promise<void> {
    await this.pool.query(
      "UPDATE findings SET payout_sent_at = $2 WHERE id = $1 AND payout_sent_at IS NULL",
      [findingId, at],
    );
  }
}
