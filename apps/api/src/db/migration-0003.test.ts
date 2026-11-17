import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "./migrate.js";

// Runs only when a Postgres instance is configured (see pg-repository tests).
const databaseUrl = process.env.DATABASE_URL;

/** Regression for 4f275dc: 0003 used to rescale every amount by 10^18 on
 * each boot, because ALTER COLUMN ... USING rewrites the column even when the
 * type is already NUMERIC. */
describe.skipIf(!databaseUrl)("migration 0003 (wei amounts)", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const sql = readFile(new URL("./migrations/0003_wei_amounts.sql", import.meta.url), "utf8");
  const contractId = `contract_${randomUUID()}`;
  const bountyId = `bounty_${randomUUID()}`;
  const WEI = "1500000000000000000"; // 1.5 ETH

  beforeAll(async () => {
    await runMigrations(pool);
  });

  afterAll(async () => {
    await pool.query("DELETE FROM bounties WHERE id = $1", [bountyId]);
    await pool.end();
  });

  async function amount(): Promise<string> {
    const { rows } = await pool.query<{ amount: string }>(
      "SELECT amount::text AS amount FROM bounties WHERE id = $1",
      [bountyId],
    );
    return rows[0]!.amount;
  }

  it("leaves wei amounts unchanged when the migrations re-run", async () => {
    await pool.query(
      `INSERT INTO bounties (id, contract_id, amount, currency, funded_at, deadline)
       VALUES ($1, $2, $3, 'ETH', now(), '2030-01-01T00:00:00Z')`,
      [bountyId, contractId, WEI],
    );

    await runMigrations(pool);
    await runMigrations(pool);
    await pool.query(await sql);

    expect(await amount()).toBe(WEI);
    const type = await pool.query<{ data_type: string; numeric_precision: number }>(
      `SELECT data_type, numeric_precision FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'bounties' AND column_name = 'amount'`,
    );
    expect(type.rows).toEqual([{ data_type: "numeric", numeric_precision: 78 }]);
  });

  it("converts a double precision ETH column to wei exactly once", async () => {
    // A scratch schema with the pre-0003 column type, so the conversion runs
    // without touching the real bounties table.
    const schema = `m0003_${randomUUID().replaceAll("-", "")}`;
    const client = await pool.connect();
    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET search_path TO ${schema}`);
      await client.query("CREATE TABLE bounties (id TEXT PRIMARY KEY, amount DOUBLE PRECISION)");
      await client.query(
        "INSERT INTO bounties (id, amount) VALUES ('a', 1.5), ('b', 0.1), ('c', 2)",
      );

      const read = async () =>
        (
          await client.query<{ id: string; amount: string }>(
            "SELECT id, amount::text AS amount FROM bounties ORDER BY id",
          )
        ).rows;
      const expected = [
        { id: "a", amount: "1500000000000000000" },
        { id: "b", amount: "100000000000000000" },
        { id: "c", amount: "2000000000000000000" },
      ];

      await client.query(await sql);
      expect(await read()).toEqual(expected);

      // Re-running is a no-op now the column is NUMERIC.
      await client.query(await sql);
      await client.query(await sql);
      expect(await read()).toEqual(expected);
    } finally {
      await client.query("RESET search_path");
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      client.release();
    }
  });
});
