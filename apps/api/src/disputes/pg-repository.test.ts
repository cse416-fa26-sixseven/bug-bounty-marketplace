import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { PgContractRepository } from "../contracts/pg-repository.js";
import { runMigrations } from "../db/migrate.js";
import { makeContract, makeFinding } from "../testing/repository-suite.js";
import { MemoryDisputeRepository } from "./memory-repository.js";
import { PgDisputeRepository } from "./pg-repository.js";
import type { DisputeRepository } from "./repository.js";

const databaseUrl = process.env.DATABASE_URL;
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : undefined;
const contractIds: string[] = [];

beforeAll(async () => {
  if (pool) await runMigrations(pool);
});

afterAll(async () => {
  if (pool && contractIds.length) {
    await pool.query("DELETE FROM disputes WHERE contract_id = ANY($1)", [contractIds]);
    await pool.query("DELETE FROM jobs WHERE subject_id = ANY($1)", [contractIds]);
    await pool.query("DELETE FROM findings WHERE contract_id = ANY($1)", [contractIds]);
    await pool.query("DELETE FROM contracts WHERE id = ANY($1)", [contractIds]);
    await pool.query("DELETE FROM bounties WHERE contract_id = ANY($1)", [contractIds]);
  }
  await pool?.end();
});

async function seedFinding(): Promise<{ contractId: string; findingId: string }> {
  const record = makeContract();
  contractIds.push(record.contract.id);
  const finding = makeFinding(record.contract.id, { status: "Verified" });
  if (pool) {
    await new PgContractRepository(pool).insertContract(record);
    await pool.query(
      `INSERT INTO findings (id, contract_id, severity, slither_detector, slither_confidence, raw_output,
         raw_output_reference, llm_explanation, explanation_source, status, status_history, is_false_positive, created_at)
       VALUES ($1,$2,'High','reentrancy-eth','Medium','{}','r','e','llm','Verified','[]',false,now())`,
      [finding.id, record.contract.id],
    );
  }
  return { contractId: record.contract.id, findingId: finding.id };
}

for (const [name, make, skip] of [
  ["Memory", () => new MemoryDisputeRepository(), false],
  ["Postgres", () => new PgDisputeRepository(pool as Pool), !pool],
] as const) {
  describe.skipIf(skip)(`${name} DisputeRepository`, () => {
    const repo: DisputeRepository = skip ? (undefined as never) : make();

    it("creates one dispute per finding, lists by ruling and rules once", async () => {
      const { contractId, findingId } = await seedFinding();
      const base = {
        findingId,
        contractId,
        developerId: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
        reason: "bad PoC",
        openedAt: "2026-10-20T12:00:00.000Z",
        challengeWindowExpiresAt: "2026-10-20T12:01:00.000Z",
        ruling: "Pending" as const,
        ruledAt: null,
        arbiterId: null,
      };
      const first = await repo.create({ ...base, id: `dispute_${findingId}` });
      const again = await repo.create({ ...base, id: `dispute_other_${findingId}` });
      expect(again.id).toBe(first.id);
      expect((await repo.findByFinding(findingId))?.id).toBe(first.id);
      expect((await repo.list("Pending")).map((d) => d.id)).toContain(first.id);

      const ruled = await repo.setRuling(first.id, "ForAuditor", "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", new Date("2026-10-20T13:00:00.000Z"));
      expect(ruled).toMatchObject({ ruling: "ForAuditor", ruledAt: "2026-10-20T13:00:00.000Z" });
      expect(await repo.setRuling(first.id, "AgainstAuditor", "x", new Date())).toBeNull();
      expect((await repo.list("Pending")).map((d) => d.id)).not.toContain(first.id);
    });

    it("lists Pending disputes past their ruling window, or with none recorded, as lapse candidates", async () => {
      const cutoff = new Date("2026-10-23T12:00:00.000Z");
      const base = {
        developerId: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
        reason: "bad PoC",
        openedAt: "2026-10-20T12:00:00.000Z",
        challengeWindowExpiresAt: "2026-10-20T12:01:00.000Z",
        ruling: "Pending" as const,
        ruledAt: null,
        arbiterId: null,
      };
      async function open(ruleBy?: Date) {
        const { contractId, findingId } = await seedFinding();
        const d = await repo.create({ ...base, id: `dispute_${findingId}`, findingId, contractId, ruleBy });
        return { id: d.id, findingId, contractId };
      }
      const closed = await open(new Date(cutoff.getTime() - 1000));
      const stillOpen = await open(cutoff);
      const unknown = await open();
      const ruled = await open(new Date(cutoff.getTime() - 1000));
      await repo.setRuling(ruled.id, "AgainstAuditor", "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", cutoff);

      // Other test files share the database, so only these rows are checked.
      const mine = new Set([closed.id, stillOpen.id, unknown.id, ruled.id]);
      const listed = (await repo.listLapseCandidates(cutoff)).filter((c) => mine.has(c.id));
      expect(listed).toEqual(
        expect.arrayContaining([
          { ...closed, ruleBy: new Date(cutoff.getTime() - 1000) },
          { ...unknown, ruleBy: null },
        ]),
      );
      expect(listed).toHaveLength(2);

      await repo.setRuleBy(unknown.id, new Date(cutoff.getTime() + 60_000));
      const after = (await repo.listLapseCandidates(cutoff)).filter((c) => mine.has(c.id));
      expect(after.map((c) => c.id)).toEqual([closed.id]);
    });
  });
}
