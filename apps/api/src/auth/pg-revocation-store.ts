import type { Pool } from "pg";
import type { SessionRevocationStore } from "./revocation-store.js";

/** Postgres SessionRevocationStore, shared by every API replica and kept
 * across restarts. Table from db/migrations/0012_revoked_sessions.sql. */
export class PgSessionRevocationStore implements SessionRevocationStore {
  constructor(private readonly pool: Pool) {}

  async revoke(sessionId: string, expiresAt: Date, now: Date): Promise<void> {
    // The insert comes first: if the prune fails, the session is still ended.
    if (expiresAt.getTime() > now.getTime()) {
      await this.pool.query(
        `INSERT INTO revoked_sessions (session_id, expires_at, revoked_at) VALUES ($1, $2, $3)
         ON CONFLICT (session_id) DO NOTHING`,
        [sessionId, expiresAt, now],
      );
    }
    await this.pool.query("DELETE FROM revoked_sessions WHERE expires_at <= $1", [now]);
  }

  async isRevoked(sessionId: string): Promise<boolean> {
    const result = await this.pool.query("SELECT 1 FROM revoked_sessions WHERE session_id = $1", [sessionId]);
    return result.rows.length > 0;
  }
}
