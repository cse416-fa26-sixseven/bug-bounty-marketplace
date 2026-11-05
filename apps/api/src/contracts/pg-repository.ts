import type { Pool, PoolClient } from "pg";
import type { Bounty, Contract, ContractStatus } from "@bbm/shared";
import { InvalidTransitionError, canTransitionContract } from "../status/transitions.js";
import type {
  ActiveClaim,
  ClaimResult,
  ContractRepository,
  NewContractRecord,
  QueueItem,
} from "./repository.js";

interface ContractRow {
  id: string;
  developer_address: string;
  filename: string;
  source_hash: string;
  source_reference: string;
  bounty_id: string;
  status: ContractStatus;
  created_at: Date;
  deadline: Date;
}

/** Columns for a contract as callers see it at time $N: a claim whose expiry
 * has passed reads back as Open. */
function contractColumns(nowParam: string): string {
  return `c.id, c.developer_address, c.filename, c.source_hash, c.source_reference, c.bounty_id,
          CASE WHEN c.status = 'Claimed' AND c.claim_expires_at <= ${nowParam} THEN 'Open'
               ELSE c.status END AS status,
          c.created_at, c.deadline`;
}

/** SQL: the newest analysis job of contract `c` is done. */
const LATEST_ANALYSIS_DONE = `(
  SELECT j.status FROM jobs j
   WHERE j.kind = 'analysis' AND j.subject_id = c.id
   ORDER BY j.created_at DESC, j.id DESC
   LIMIT 1) = 'done'`;

/** SQL: the auditor (`$2`) holds an active claim, or a claim with a lock
 * state, on a contract other than `$1`. `nowParam` is the placeholder for now. */
function holdsAnotherClaim(nowParam: string): string {
  return `EXISTS (
    SELECT 1 FROM contracts o
     WHERE o.claimed_by_auditor_id = $2 AND o.id <> $1
       AND ((o.status = 'Claimed' AND o.claim_expires_at > ${nowParam})
            OR o.claim_lock_status IN ('locking', 'locked', 'unlocking')))`;
}

/** Explains a claim the UPDATE refused: not found, not open (including a
 * pending lock state on the contract), or the auditor holds another claim. */
async function refusedClaim(
  client: PoolClient,
  contractId: string,
  auditorId: string,
  now: Date,
): Promise<ClaimResult> {
  const result = await client.query<{
    status: string;
    claim_expires_at: Date | null;
    claim_lock_status: string | null;
    holds: boolean;
  }>(
    `SELECT c.status, c.claim_expires_at, c.claim_lock_status, ${holdsAnotherClaim("$3")} AS holds
       FROM contracts c WHERE c.id = $1`,
    [contractId, auditorId, now],
  );
  const row = result.rows[0];
  if (!row) return { ok: false, reason: "not_found" };
  const open =
    row.status === "Open" ||
    (row.status === "Claimed" &&
      row.claim_expires_at !== null &&
      row.claim_expires_at.getTime() <= now.getTime());
  const lockFree = row.claim_lock_status === null || row.claim_lock_status === "released";
  if (!open || !lockFree) return { ok: false, reason: "not_open" };
  return { ok: false, reason: row.holds ? "auditor_has_claim" : "not_open" };
}

function toContract(row: ContractRow): Contract {
  return {
    id: row.id,
    developerAddress: row.developer_address,
    filename: row.filename,
    sourceHash: row.source_hash,
    sourceReference: row.source_reference,
    bountyId: row.bounty_id,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    deadline: row.deadline.toISOString(),
  };
}

/** PostgreSQL-backed repository. Schema lives in db/migrations. */
export class PgContractRepository implements ContractRepository {
  constructor(private readonly pool: Pool) {}

  async insertContract({ contract, bounty, analysisJob }: NewContractRecord): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO bounties (id, contract_id, amount, currency, funded_at, deadline)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          bounty.id,
          bounty.contractId,
          bounty.amount,
          bounty.currency,
          bounty.fundedAt,
          bounty.deadline,
        ],
      );
      await client.query(
        `INSERT INTO contracts
           (id, developer_address, filename, source_hash, source_reference, bounty_id, status, created_at, deadline)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          contract.id,
          contract.developerAddress,
          contract.filename,
          contract.sourceHash,
          contract.sourceReference,
          contract.bountyId,
          contract.status,
          contract.createdAt,
          contract.deadline,
        ],
      );
      await client.query(
        `INSERT INTO jobs (id, kind, subject_id, status, attempts, created_at, updated_at)
         VALUES ($1, $2, $3, 'queued', 0, $4, $4)`,
        [analysisJob.id, analysisJob.kind, analysisJob.subjectId, analysisJob.createdAt],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async findContractById(id: string, now: Date = new Date()): Promise<Contract | null> {
    const result = await this.pool.query<ContractRow>(
      `SELECT ${contractColumns("$2")} FROM contracts c WHERE c.id = $1`,
      [id, now],
    );
    const row = result.rows[0];
    return row ? toContract(row) : null;
  }

  async listContracts(
    filter: { developerAddress?: string },
    now: Date = new Date(),
  ): Promise<Contract[]> {
    const result = await this.pool.query<ContractRow>(
      `SELECT ${contractColumns("$1")} FROM contracts c
        WHERE $2::text IS NULL OR lower(c.developer_address) = lower($2)
        ORDER BY c.created_at DESC, c.id`,
      [now, filter.developerAddress ?? null],
    );
    return result.rows.map(toContract);
  }

  async claimContract(
    contractId: string,
    auditorId: string,
    expiresAt: Date,
    now: Date,
  ): Promise<ClaimResult> {
    // A transaction-scoped advisory lock per auditor serializes claims by one
    // auditor, so the "holds another claim" check cannot race with a second claim
    // on a different contract. The UPDATE's WHERE clause still decides the race
    // for one contract.
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `claim:${auditorId}`,
      ]);
      const result = await client.query<ContractRow>(
        `UPDATE contracts c
            SET status = 'Claimed', claimed_by_auditor_id = $2, claim_expires_at = $3,
                claim_lock_status = NULL, claim_lock_before = NULL
          WHERE c.id = $1
            AND (c.status = 'Open' OR (c.status = 'Claimed' AND c.claim_expires_at <= $4))
            AND (c.claim_lock_status IS NULL OR c.claim_lock_status = 'released')
            AND NOT ${holdsAnotherClaim("$4")}
          RETURNING ${contractColumns("$4")}`,
        [contractId, auditorId, expiresAt, now],
      );
      const row = result.rows[0];
      const outcome: ClaimResult = row
        ? { ok: true, contract: toContract(row) }
        : await refusedClaim(client, contractId, auditorId, now);
      await client.query("COMMIT");
      return outcome;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async releaseClaim(contractId: string, auditorId: string): Promise<void> {
    // A pending lock ('locking') or unlock ('unlocking') keeps the holder and the
    // state: the sweep needs both to finish it after the claim is rolled back.
    await this.pool.query(
      `UPDATE contracts
          SET status = 'Open', claim_expires_at = NULL,
              claimed_by_auditor_id = CASE WHEN claim_lock_status IN ('locking', 'unlocking')
                                           THEN claimed_by_auditor_id END,
              claim_lock_status = CASE WHEN claim_lock_status IN ('locking', 'unlocking')
                                       THEN claim_lock_status END
        WHERE id = $1 AND status = 'Claimed' AND claimed_by_auditor_id = $2`,
      [contractId, auditorId],
    );
  }

  async releaseClaimIfUnlocked(contractId: string, auditorId: string): Promise<void> {
    await this.pool.query(
      `UPDATE contracts
          SET status = 'Open', claim_expires_at = NULL, claimed_by_auditor_id = NULL,
              claim_lock_status = NULL, claim_lock_before = NULL
        WHERE id = $1 AND status = 'Claimed' AND lower(claimed_by_auditor_id) = lower($2)
          AND (claim_lock_status IS NULL OR claim_lock_status = 'released')`,
      [contractId, auditorId],
    );
  }

  async listQueue(now: Date, options: { fundedOnly?: boolean } = {}): Promise<QueueItem[]> {
    // Same eligibility as claimContract: a contract with a pending or held lock
    // state is not claimable, so it is not listed either.
    const result = await this.pool.query<ContractRow & { amount: string; currency: string }>(
      `SELECT ${contractColumns("$1")}, b.amount, b.currency
         FROM contracts c JOIN bounties b ON b.id = c.bounty_id
        WHERE (c.status = 'Open' OR (c.status = 'Claimed' AND c.claim_expires_at <= $1))
          AND (c.claim_lock_status IS NULL OR c.claim_lock_status = 'released')
          AND ($2::boolean = false OR b.onchain_funded_at IS NOT NULL)
          AND ${LATEST_ANALYSIS_DONE}`,
      [now, options.fundedOnly ?? false],
    );
    return result.rows.map((row) => ({
      ...toContract(row),
      bounty: { amount: String(row.amount), currency: row.currency },
    }));
  }

  async findActiveClaim(contractId: string, now: Date): Promise<ActiveClaim | null> {
    const result = await this.pool.query<{ claimed_by_auditor_id: string; claim_expires_at: Date }>(
      `SELECT claimed_by_auditor_id, claim_expires_at FROM contracts
        WHERE id = $1 AND status = 'Claimed' AND claim_expires_at > $2`,
      [contractId, now],
    );
    const row = result.rows[0];
    return row ? { auditorId: row.claimed_by_auditor_id, expiresAt: row.claim_expires_at } : null;
  }

  async findBounty(contractId: string): Promise<Bounty | null> {
    const result = await this.pool.query<{
      id: string;
      contract_id: string;
      amount: string;
      currency: string;
      funded_at: Date;
      deadline: Date;
    }>(
      "SELECT id, contract_id, amount, currency, funded_at, deadline FROM bounties WHERE contract_id = $1",
      [contractId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      contractId: row.contract_id,
      amount: String(row.amount),
      currency: row.currency,
      fundedAt: row.funded_at.toISOString(),
      deadline: row.deadline.toISOString(),
    };
  }

  async listClaimedContractIds(auditorId: string, now: Date): Promise<string[]> {
    const result = await this.pool.query<{ id: string }>(
      `SELECT id FROM contracts
        WHERE status = 'Claimed' AND claimed_by_auditor_id = $1 AND claim_expires_at > $2
        ORDER BY id`,
      [auditorId, now],
    );
    return result.rows.map((row) => row.id);
  }

  async isAnalysisDone(contractId: string): Promise<boolean> {
    const result = await this.pool.query<{ done: boolean }>(
      `SELECT ${LATEST_ANALYSIS_DONE} AS done FROM contracts c WHERE c.id = $1`,
      [contractId],
    );
    return result.rows[0]?.done ?? false;
  }

  async isFunded(contractId: string): Promise<boolean> {
    const result = await this.pool.query<{ funded: boolean }>(
      "SELECT onchain_funded_at IS NOT NULL AS funded FROM bounties WHERE contract_id = $1",
      [contractId],
    );
    return result.rows[0]?.funded ?? false;
  }

  async markFunded(contractId: string, at: Date): Promise<void> {
    await this.pool.query(
      "UPDATE bounties SET onchain_funded_at = COALESCE(onchain_funded_at, $2) WHERE contract_id = $1",
      [contractId, at],
    );
  }

  async setContractStatus(
    contractId: string,
    next: ContractStatus,
    now: Date = new Date(),
  ): Promise<Contract | null> {
    const current = await this.findContractById(contractId, now);
    if (!current) return null;
    if (current.status === next) return current;
    if (!canTransitionContract(current.status, next)) {
      throw new InvalidTransitionError("contract", current.status, next);
    }
    // Guard on the status read so a concurrent claim or resolution is not
    // overwritten. Leaving Claimed clears the claim columns, except while a
    // claim lock is held: the unlock sweep needs the holder and expiry.
    const result = await this.pool.query(
      `UPDATE contracts
          SET status = $2,
              claimed_by_auditor_id = CASE WHEN $2 = 'Claimed'
                                             OR claim_lock_status IN ('locking', 'locked', 'unlocking')
                                           THEN claimed_by_auditor_id END,
              claim_expires_at = CASE WHEN $2 = 'Claimed'
                                        OR claim_lock_status IN ('locking', 'locked', 'unlocking')
                                      THEN claim_expires_at END
        WHERE id = $1 AND status = ANY($3::text[])`,
      [contractId, next, current.status === "Open" ? ["Open", "Claimed"] : [current.status]],
    );
    if (result.rowCount !== 1) throw new InvalidTransitionError("contract", current.status, next);
    return this.findContractById(contractId, now);
  }
}
