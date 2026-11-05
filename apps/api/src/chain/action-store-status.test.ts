import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import type { Hash } from "viem";
import type { FindingStatus } from "@bbm/shared";
import { MemoryContractRepository } from "../contracts/memory-repository.js";
import { PgContractRepository } from "../contracts/pg-repository.js";
import type { ContractRepository } from "../contracts/repository.js";
import { runMigrations } from "../db/migrate.js";
import { MemoryStore } from "../pipeline/memory-repository.js";
import { PgPipelineRepository } from "../pipeline/pg-repository.js";
import type { FindingRecord } from "../pipeline/repository.js";
import { InvalidTransitionError } from "../status/transitions.js";
import { makeContract, makeFinding } from "../testing/repository-suite.js";
import type { ChainActionStore } from "./action-store.js";
import { createChainActions } from "./actions.js";
import type { AuditorStakingPort } from "./auditor-staking.js";
import { MemoryChainActionStore } from "./memory-action-store.js";
import { PgChainActionStore } from "./pg-action-store.js";

// Postgres runs only with DATABASE_URL set, like the other pg suites.
const databaseUrl = process.env.DATABASE_URL;
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : undefined;
const createdContracts: string[] = [];

beforeAll(async () => {
  if (pool) await runMigrations(pool);
});

afterAll(async () => {
  if (pool && createdContracts.length > 0) {
    await pool.query("DELETE FROM jobs WHERE subject_id = ANY($1)", [createdContracts]);
    await pool.query(
      "DELETE FROM poc_submissions WHERE finding_id IN (SELECT id FROM findings WHERE contract_id = ANY($1))",
      [createdContracts],
    );
    await pool.query("DELETE FROM findings WHERE contract_id = ANY($1)", [createdContracts]);
    await pool.query("DELETE FROM contracts WHERE id = ANY($1)", [createdContracts]);
    await pool.query("DELETE FROM bounties WHERE contract_id = ANY($1)", [createdContracts]);
  }
  await pool?.end();
});

interface Harness {
  store: ChainActionStore;
  contracts: ContractRepository;
  seed(record: FindingRecord): Promise<void>;
  seedPoc(findingId: string, auditorId: string): Promise<void>;
  /** Claims the contract until `expiresAt` and takes the claim to "locked". */
  claimLocked(contractId: string, auditorId: string, expiresAt: Date): Promise<void>;
  finding(id: string): Promise<{ status: FindingStatus; history: number; window: string | null }>;
}

const WINDOW_SECONDS = 60;
const HASH = `0x${"ab".repeat(32)}` as Hash;
const AT = "2026-10-20T12:00:00.000Z";

let pocCount = 0;
function pocId() {
  pocCount += 1;
  return `poc_${process.pid}_${Date.now()}_${pocCount}`;
}

async function lock(store: ChainActionStore, contractId: string, auditorId: string) {
  expect(await store.markClaimLocking(contractId, auditorId, 0n)).toBe(true);
  expect(await store.markClaimLocked(contractId, auditorId)).toBe(true);
}

function memoryHarness(): Harness {
  const mem = new MemoryStore();
  const store = new MemoryChainActionStore(mem, { challengeWindowSeconds: WINDOW_SECONDS });
  const contracts = new MemoryContractRepository(mem);
  return {
    store,
    contracts,
    seed: async (record) => {
      mem.findings.set(record.id, structuredClone(record));
    },
    seedPoc: async (findingId, auditorId) => {
      const id = pocId();
      mem.pocs.set(id, {
        id,
        findingId,
        auditorId,
        testFileReference: `pocs/${id}/x.t.sol`,
        submittedAt: AT,
        sandboxStatus: "Pending",
        sandboxLog: null,
      });
    },
    claimLocked: async (contractId, auditorId, expiresAt) => {
      const claimed = await contracts.claimContract(contractId, auditorId, expiresAt, new Date(AT));
      expect(claimed.ok).toBe(true);
      await lock(store, contractId, auditorId);
    },
    finding: async (id) => {
      const r = mem.findings.get(id)!;
      return { status: r.status, history: r.statusHistory.length, window: r.challengeWindowExpiresAt };
    },
  };
}

function pgHarness(): Harness {
  const db = pool as Pool;
  const repo = new PgContractRepository(db);
  const pipeline = new PgPipelineRepository(db);
  const store = new PgChainActionStore(db, { challengeWindowSeconds: WINDOW_SECONDS });
  return {
    store,
    contracts: {
      ...repo,
      insertContract: async (record) => {
        createdContracts.push(record.contract.id);
        await repo.insertContract(record);
      },
      findContractById: (id, now) => repo.findContractById(id, now),
    } as ContractRepository,
    seed: async (f) => {
      await db.query(
        `INSERT INTO findings (id, contract_id, severity, slither_detector, slither_confidence, raw_output,
           raw_output_reference, llm_explanation, explanation_source, status, status_history,
           is_false_positive, challenge_window_expires_at, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          f.id, f.contractId, f.severity, f.slitherDetector, f.slitherConfidence,
          JSON.stringify(f.rawOutput), f.rawOutputReference, f.llmExplanation, f.explanationSource,
          f.status, JSON.stringify(f.statusHistory), f.isFalsePositive, f.challengeWindowExpiresAt,
          f.createdAt,
        ],
      );
    },
    seedPoc: async (findingId, auditorId) => {
      const id = pocId();
      await db.query(
        `INSERT INTO poc_submissions (id, finding_id, auditor_id, test_file_reference, submitted_at, sandbox_status)
         VALUES ($1, $2, $3, $4, $5, 'Pending')`,
        [id, findingId, auditorId, `pocs/${id}/x.t.sol`, AT],
      );
    },
    claimLocked: async (contractId, auditorId, expiresAt) => {
      const claimed = await repo.claimContract(contractId, auditorId, expiresAt, new Date(AT));
      expect(claimed.ok).toBe(true);
      await lock(store, contractId, auditorId);
    },
    finding: async (id) => {
      const found = await pipeline.findFinding(id, new Date());
      return {
        status: found!.status,
        history: found!.statusHistory.length,
        window: found!.challengeWindowExpiresAt,
      };
    },
  };
}

for (const [name, make, skip] of [
  ["Memory", memoryHarness, false],
  ["Postgres", pgHarness, !pool],
] as const) {
  describe.skipIf(skip)(`${name} ChainActionStore status writes`, () => {
    const h = skip ? (undefined as unknown as Harness) : make();

    async function seeded(status: FindingStatus) {
      const record = makeContract();
      await h.contracts.insertContract(record);
      const finding = makeFinding(record.contract.id, {
        status,
        statusHistory: [{ status, changedAt: AT }],
      });
      await h.seed(finding);
      return { contractId: record.contract.id, findingId: finding.id };
    }

    it("Verified sets the challenge window from the change time", async () => {
      const { findingId } = await seeded("Submitted");
      await h.store.setFindingStatus(findingId, "Verified", AT);
      const f = await h.finding(findingId);
      expect(f.status).toBe("Verified");
      expect(f.window).toBe(new Date(Date.parse(AT) + WINDOW_SECONDS * 1000).toISOString());
    });

    it("Disputed to Verified opens a new challenge window", async () => {
      const { findingId } = await seeded("Disputed");
      const later = "2026-10-20T13:00:00.000Z";
      await h.store.setFindingStatus(findingId, "Verified", later);
      expect((await h.finding(findingId)).window).toBe(
        new Date(Date.parse(later) + WINDOW_SECONDS * 1000).toISOString(),
      );
    });

    it("writing Verified again leaves the window unchanged", async () => {
      const { findingId } = await seeded("Submitted");
      await h.store.setFindingStatus(findingId, "Verified", AT);
      await h.store.setFindingStatus(findingId, "Verified", "2026-10-20T15:00:00.000Z");
      expect((await h.finding(findingId)).window).toBe(
        new Date(Date.parse(AT) + WINDOW_SECONDS * 1000).toISOString(),
      );
    });

    it("Paid resolves the finding's contract", async () => {
      const { contractId, findingId } = await seeded("Verified");
      await h.store.setFindingStatus(findingId, "Paid", AT);
      expect((await h.finding(findingId)).status).toBe("Paid");
      expect((await h.contracts.findContractById(contractId))?.status).toBe("Resolved");
    });

    it("writing the current status again is a no-op", async () => {
      const { findingId } = await seeded("Verified");
      await h.store.setFindingStatus(findingId, "Disputed", AT);
      await h.store.setFindingStatus(findingId, "Disputed", AT);
      const f = await h.finding(findingId);
      expect(f.status).toBe("Disputed");
      expect(f.history).toBe(2);
    });

    it("an illegal move throws InvalidTransitionError and changes nothing", async () => {
      const { findingId } = await seeded("Paid");
      await expect(h.store.setFindingStatus(findingId, "Disputed", AT)).rejects.toBeInstanceOf(
        InvalidTransitionError,
      );
      expect((await h.finding(findingId)).status).toBe("Paid");
    });
  });
}

for (const [name, make, skip] of [
  ["Memory", memoryHarness, false],
  ["Postgres", pgHarness, !pool],
] as const) {
  describe.skipIf(skip)(`${name} ChainActionStore expired claim locks`, () => {
    const h = skip ? (undefined as unknown as Harness) : make();
    // An auditor holds one claim at a time, so each case gets its own.
    let auditors = 0;
    function newAuditor() {
      auditors += 1;
      const tail = `${process.pid}${Date.now()}${auditors}`.slice(-40).padStart(40, "a");
      return `0x${tail.replace(/a/g, "A")}`;
    }
    const EXPIRES = new Date(Date.parse(AT) + 60_000);
    const AFTER = new Date(EXPIRES.getTime() + 1);

    /** A contract claimed and locked by a fresh auditor until EXPIRES, with one
     * finding in `status` carrying a PoC by `pocAuditor`. */
    async function lockedWith(status: FindingStatus, pocAuditor?: (auditor: string) => string) {
      const auditor = newAuditor();
      const record = makeContract();
      await h.contracts.insertContract(record);
      const contractId = record.contract.id;
      const finding = makeFinding(contractId, { status, statusHistory: [{ status, changedAt: AT }] });
      await h.seed(finding);
      await h.seedPoc(finding.id, pocAuditor ? pocAuditor(auditor) : auditor);
      await h.claimLocked(contractId, auditor, EXPIRES);
      return { contractId, auditor, findingId: finding.id };
    }

    /** Another finding on the contract in `status`, with a PoC by `auditor`. */
    async function addFinding(contractId: string, auditor: string, status: FindingStatus) {
      const finding = makeFinding(contractId, { status, statusHistory: [{ status, changedAt: AT }] });
      await h.seed(finding);
      await h.seedPoc(finding.id, auditor);
      return finding.id;
    }

    async function listed(contractId: string) {
      return (await h.store.listExpiredLockedClaims(AFTER, contractId)).map((c) => c.contractId);
    }

    it.each(["Submitted", "Verified", "Disputed"] as const)(
      "keeps the lock of an expired claim backing a %s finding",
      async (status) => {
        const { contractId } = await lockedWith(status);
        expect(await listed(contractId)).toEqual([]);
        await expect(h.store.takeClaimUnlock(contractId, { expiredBy: AFTER })).resolves.toBeNull();
      },
    );

    it.each(["Flagged", "Rejected", "Paid"] as const)(
      "releases the lock of an expired claim whose finding is %s",
      async (status) => {
        const { contractId, auditor } = await lockedWith(status);
        expect(await listed(contractId)).toEqual([contractId]);
        await expect(h.store.takeClaimUnlock(contractId, { expiredBy: AFTER })).resolves.toBe(auditor);
      },
    );

    it("matches the PoC auditor case-insensitively", async () => {
      const { contractId } = await lockedWith("Verified", (auditor) => auditor.toLowerCase());
      expect(await listed(contractId)).toEqual([]);
    });

    it("ignores another auditor's pending finding on the contract", async () => {
      const { contractId } = await lockedWith("Verified", () => newAuditor());
      expect(await listed(contractId)).toEqual([contractId]);
    });

    it("still unlocks a pending finding's claim when no expiry is given", async () => {
      // Verdict and dispute paths unlock by auditor, not by expiry.
      const { contractId, auditor } = await lockedWith("Submitted");
      await expect(h.store.takeClaimUnlock(contractId, { auditorId: auditor })).resolves.toBe(auditor);
    });

    it.each(["Submitted", "Verified", "Disputed"] as const)(
      "settling one finding keeps the lock while the auditor's other finding on the contract is %s",
      async (other) => {
        // A Failed verdict or a lost dispute on one finding must not free the
        // stake another finding's verification or payout still needs.
        const { contractId, auditor, findingId } = await lockedWith("Submitted");
        await addFinding(contractId, auditor, other);
        await expect(
          h.store.takeClaimUnlock(contractId, { auditorId: auditor, settling: findingId }),
        ).resolves.toBeNull();
      },
    );

    it("settling the auditor's only pending finding releases the lock", async () => {
      const { contractId, auditor, findingId } = await lockedWith("Submitted");
      await addFinding(contractId, auditor, "Rejected");
      await addFinding(contractId, newAuditor(), "Verified"); // someone else's
      await expect(
        h.store.takeClaimUnlock(contractId, { auditorId: auditor, settling: findingId }),
      ).resolves.toBe(auditor);
    });

    it("a cancelled or refunded bounty releases the lock of a finding still awaiting its verdict", async () => {
      // The finding is Submitted with the sandbox verdict pending, so nothing
      // is on-chain yet. Once the bounty is closed, a Passed verdict cannot be
      // recorded (BountyNotOpen) and the finding never leaves Submitted: only
      // the close can release this lock.
      const { contractId, auditor } = await lockedWith("Submitted");
      const auditorStaking = {
        stakeOf: vi.fn(async () => 0n),
        reputation: vi.fn(async () => 0n),
        activeSubmissions: vi.fn(async () => 1n),
        lockSubmission: vi.fn(async () => HASH),
        unlockSubmission: vi.fn(async () => HASH),
      } satisfies AuditorStakingPort;
      const actions = createChainActions({ store: h.store, auditorStaking, claimLockEnabled: true });

      // The expiry sweep keeps it, however late it runs ...
      await expect(actions.releaseExpiredLocks(new Date(8.64e15), contractId)).resolves.toBe(0);
      expect(auditorStaking.unlockSubmission).not.toHaveBeenCalled();
      // ... but closing the bounty releases it, once.
      await expect(actions.releaseClaimLock(contractId)).resolves.toBe(true);
      await expect(actions.releaseClaimLock(contractId)).resolves.toBe(false);
      expect(auditorStaking.unlockSubmission).toHaveBeenCalledTimes(1);
      expect(auditorStaking.unlockSubmission).toHaveBeenCalledWith(auditor);
      await expect(h.store.findUnlockingClaims(contractId)).resolves.toEqual([]);
    });
  });
}
