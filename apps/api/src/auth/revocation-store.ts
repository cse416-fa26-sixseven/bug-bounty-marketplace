/**
 * Sessions ended before their expiry (logout). A session cookie whose id is
 * listed here is refused. Entries are kept until the session would have
 * expired anyway.
 */
export interface SessionRevocationStore {
  /** Ends the session. `expiresAt` is when its cookie expires on its own.
   * Also drops entries whose sessions have expired by `now`. Idempotent. */
  revoke(sessionId: string, expiresAt: Date, now: Date): Promise<void>;
  isRevoked(sessionId: string): Promise<boolean>;
}

/** In-memory SessionRevocationStore. Tests and the no-DATABASE_URL setup:
 * revocations are lost when the process restarts. */
export class MemorySessionRevocationStore implements SessionRevocationStore {
  private readonly revoked = new Map<string, number>();

  async revoke(sessionId: string, expiresAt: Date, now: Date): Promise<void> {
    for (const [id, expires] of this.revoked) if (expires <= now.getTime()) this.revoked.delete(id);
    if (expiresAt.getTime() > now.getTime()) this.revoked.set(sessionId, expiresAt.getTime());
  }

  async isRevoked(sessionId: string): Promise<boolean> {
    return this.revoked.has(sessionId);
  }

  /** How many entries are held (for tests). */
  get size(): number {
    return this.revoked.size;
  }
}
