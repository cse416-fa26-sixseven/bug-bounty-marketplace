import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "./migrate.js";

// Runs only when a Postgres instance is configured (see pg-repository tests).
const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("migration 0011", () => {
  const pool = new Pool({ connectionString: databaseUrl });

  beforeAll(async () => {
    await runMigrations(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("adds a nullable rule_by timestamp to disputes", async () => {
    const result = await pool.query<{ data_type: string; is_nullable: string }>(
      `SELECT data_type, is_nullable FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'disputes' AND column_name = 'rule_by'`,
    );
    expect(result.rows).toEqual([{ data_type: "timestamp with time zone", is_nullable: "YES" }]);
  });

  it("re-runs without waiting on readers of disputes (no ACCESS EXCLUSIVE lock)", async () => {
    const reader = await pool.connect();
    try {
      // The arbiter view reading disputes holds ACCESS SHARE until commit.
      await reader.query("BEGIN");
      await reader.query("SELECT 1 FROM disputes LIMIT 1");
      const rerun = runMigrations(pool);
      const timedOut = new Promise((resolve) => setTimeout(() => resolve("timed out"), 5_000));
      expect(await Promise.race([rerun.then(() => "done"), timedOut])).toBe("done");
    } finally {
      await reader.query("ROLLBACK");
      reader.release();
    }
  });
});
