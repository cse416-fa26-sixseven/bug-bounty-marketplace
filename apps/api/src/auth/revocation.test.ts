import { createHmac } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type AppOptions } from "../app.js";
import type { ChainConfig } from "../chain/config.js";
import { runMigrations } from "../db/migrate.js";
import { ARBITER, AUDITOR, DEVELOPER, signIn } from "../testing/session.js";
import { PgSessionRevocationStore } from "./pg-revocation-store.js";
import { MemorySessionRevocationStore, type SessionRevocationStore } from "./revocation-store.js";

const SECRET = "test-session-secret";
const T0 = new Date("2026-10-20T12:00:00.000Z");
const HOUR = 3_600_000;
const CONFIG: ChainConfig = {
  rpcUrl: "http://rpc.invalid",
  publicRpcUrl: null,
  chainId: 31337,
  operatorPrivateKey: `0x${"11".repeat(32)}`,
  auditorStakingAddress: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
  bountyEscrowAddress: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
  disputeResolutionAddress: "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0",
  arbiterAddress: ARBITER.address,
  challengeWindowSeconds: 60,
};

/** A chain-mode app (every user route registered), with no real chain behind it. */
function setup(options: Partial<AppOptions> = {}) {
  const clock = { now: T0 };
  const revocations = new MemorySessionRevocationStore();
  const app = buildApp({
    sessionSecret: SECRET,
    now: () => clock.now,
    config: { now: () => clock.now, claimWindowSeconds: 600 } as never,
    chainConfig: CONFIG,
    bountyEscrow: { readBounty: async () => null as never },
    disputeResolution: { getDispute: async () => null },
    auditorStaking: { stakeOf: async () => 0n, reputation: async () => 0n, activeSubmissions: async () => 0n },
    sessionRevocations: revocations,
    ...options,
  });
  const me = (cookie: string) => app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
  const logout = (cookie?: string) =>
    app.inject({ method: "POST", url: "/api/auth/logout", headers: cookie ? { cookie } : {} });
  return { app, clock, revocations, me, logout };
}

const MULTIPART = {
  headers: { "content-type": "multipart/form-data; boundary=b" },
  payload:
    '--b\r\nContent-Disposition: form-data; name="file"; filename="a.sol"\r\n' +
    "Content-Type: text/plain\r\n\r\ncontract A {}\r\n--b--\r\n",
};

/** Every route that acts for the signed-in wallet. */
const USER_ROUTES: { method: "GET" | "POST" | "PUT"; url: string; headers?: Record<string, string>; payload?: unknown }[] = [
  { method: "GET", url: "/api/auth/me" },
  { method: "POST", url: "/api/contracts", ...MULTIPART },
  { method: "POST", url: "/api/contracts/c1/funded" },
  { method: "POST", url: "/api/contracts/c1/cancel" },
  { method: "POST", url: "/api/contracts/c1/reclaim" },
  { method: "PUT", url: "/api/findings/f1/note", payload: { note: "n" } },
  { method: "POST", url: "/api/auditor/claim", payload: { contractId: "c1" } },
  { method: "POST", url: "/api/auditor/poc", ...MULTIPART },
  { method: "POST", url: "/api/auditor/findings", ...MULTIPART },
  { method: "GET", url: "/api/auditor/profile" },
  { method: "POST", url: "/api/findings/f1/false-positive" },
  { method: "POST", url: "/api/findings/f1/dispute", payload: { reason: "r" } },
  { method: "GET", url: "/api/arbiter/disputes" },
  { method: "POST", url: "/api/arbiter/disputes/d1/rule", payload: { ruling: "ForAuditor" } },
];

describe("logout ends the session server-side", () => {
  it("refuses a copied cookie on /api/auth/me after logout", async () => {
    const { app, me, logout } = setup();
    const cookie = await signIn(app, AUDITOR);
    expect((await me(cookie)).statusCode).toBe(200);

    const out = await logout(cookie);
    expect(out.statusCode).toBe(200);
    expect(out.json()).toEqual({ ok: true });
    expect(String(out.headers["set-cookie"])).toMatch(/bbm_session=;.*Max-Age=0/i);

    const copied = await me(cookie);
    expect(copied.statusCode).toBe(401);
    expect(copied.json()).toEqual({ error: "sign in first" });
  });

  it.each(USER_ROUTES)("refuses a logged-out cookie on $method $url", async (route) => {
    const { app, logout } = setup();
    // The arbiter passes the arbiter-only routes too.
    const cookie = await signIn(app, ARBITER);
    const send = () =>
      app.inject({
        method: route.method,
        url: route.url,
        headers: { cookie, ...route.headers },
        payload: route.payload as never,
      });
    // Signed in, the route gets past the session check.
    expect((await send()).statusCode).not.toBe(401);
    await logout(cookie);
    const after = await send();
    expect(after.statusCode).toBe(401);
    expect(after.json()).toEqual({ error: "sign in first" });
  });

  it("leaves the address's other sessions signed in", async () => {
    const { app, me, logout } = setup();
    const laptop = await signIn(app, AUDITOR);
    const phone = await signIn(app, AUDITOR);
    expect(laptop).not.toBe(phone);
    const other = await signIn(app, DEVELOPER);

    await logout(laptop);
    expect((await me(laptop)).statusCode).toBe(401);
    expect((await me(phone)).json()).toEqual({ address: AUDITOR.address });
    expect((await me(other)).json()).toEqual({ address: DEVELOPER.address });
    // Signing in again gives a new, working session.
    expect((await me(await signIn(app, AUDITOR))).statusCode).toBe(200);
  });

  it("keeps the session logged out across a restart that shares the store", async () => {
    const first = setup();
    const kept = await signIn(first.app, AUDITOR);
    const ended = await signIn(first.app, AUDITOR);
    await first.logout(ended);

    // A new app (a new Auth) over the same store, as after a restart with Postgres.
    const second = setup({ sessionRevocations: first.revocations });
    expect((await second.me(ended)).statusCode).toBe(401);
    expect((await second.me(kept)).statusCode).toBe(200);
  });

  it("is a 200 without a cookie, or with one that is not a valid session", async () => {
    const { app, clock, revocations, logout } = setup();
    expect((await logout()).statusCode).toBe(200);
    expect((await logout("bbm_session=garbage")).statusCode).toBe(200);
    const cookie = await signIn(app, AUDITOR);
    const tampered = cookie.slice(0, -2) + (cookie.endsWith("aa") ? "bb" : "aa");
    expect((await logout(tampered)).statusCode).toBe(200);
    expect(revocations.size).toBe(0);
    // An expired session needs no entry.
    clock.now = new Date(T0.getTime() + 9 * HOUR);
    expect((await logout(cookie)).statusCode).toBe(200);
    expect(revocations.size).toBe(0);
  });

  it("can be repeated for the same session", async () => {
    const { app, revocations, me, logout } = setup();
    const cookie = await signIn(app, AUDITOR);
    expect((await logout(cookie)).statusCode).toBe(200);
    expect((await logout(cookie)).statusCode).toBe(200);
    expect(revocations.size).toBe(1);
    expect((await me(cookie)).statusCode).toBe(401);
  });

  it("drops logged-out sessions once they would have expired anyway", async () => {
    const { app, clock, revocations, me, logout } = setup();
    const early = await signIn(app, AUDITOR);
    await logout(early);
    expect(revocations.size).toBe(1);

    // Seven hours on the first session is still within its 8 hours.
    clock.now = new Date(T0.getTime() + 7 * HOUR);
    const late = await signIn(app, AUDITOR);
    await logout(late);
    expect(revocations.size).toBe(2);
    expect((await me(early)).statusCode).toBe(401);

    // Past the first session's expiry, the next logout prunes its entry.
    clock.now = new Date(T0.getTime() + 9 * HOUR);
    await logout(await signIn(app, AUDITOR));
    expect(revocations.size).toBe(2);
    expect(await revocations.isRevoked(sessionIdOf(early))).toBe(false);
    expect(await revocations.isRevoked(sessionIdOf(late))).toBe(true);
    expect((await me(early)).statusCode).toBe(401);
  });

  it("refuses a signed cookie in the old format, which has no session id", async () => {
    const { me } = setup();
    const sign = (fields: string) => {
      const payload = Buffer.from(fields).toString("base64url");
      return `bbm_session=${payload}.${createHmac("sha256", SECRET).update(payload).digest("base64url")}`;
    };
    const expires = T0.getTime() + HOUR;
    // The new format, signed the same way, is accepted: the helper is sound.
    expect((await me(sign(`${AUDITOR.address}|${expires}|${"ab".repeat(16)}`))).statusCode).toBe(200);
    expect((await me(sign(`${AUDITOR.address}|${expires}`))).statusCode).toBe(401);
    expect((await me(sign(`${AUDITOR.address}|${expires}|`))).statusCode).toBe(401);
    expect((await me(sign(`${AUDITOR.address}|${expires}|not-a-session-id`))).statusCode).toBe(401);
    expect((await me(sign(`${AUDITOR.address}|${expires}|${"ab".repeat(16)}|extra`))).statusCode).toBe(401);
  });

  it("does not let a session in when the store cannot be read", async () => {
    const down: SessionRevocationStore = {
      revoke: async () => {
        throw new Error("db down");
      },
      isRevoked: async () => {
        throw new Error("db down");
      },
    };
    const { app, me, logout } = setup({ sessionRevocations: down });
    const cookie = await signIn(app, AUDITOR);
    expect((await me(cookie)).statusCode).toBe(500);
    const profile = await app.inject({ method: "GET", url: "/api/auditor/profile", headers: { cookie } });
    expect(profile.statusCode).toBe(500);
    // A logout that could not end the session says so, and still clears the cookie.
    const out = await logout(cookie);
    expect(out.statusCode).toBe(500);
    expect(String(out.headers["set-cookie"])).toMatch(/bbm_session=;.*Max-Age=0/i);
  });
});

/** The session id inside a `bbm_session=...` cookie. */
function sessionIdOf(cookie: string): string {
  const payload = cookie.slice(cookie.indexOf("=") + 1).split(".")[0]!;
  return Buffer.from(payload, "base64url").toString("utf8").split("|")[2]!;
}

const databaseUrl = process.env.DATABASE_URL;
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : undefined;

beforeAll(async () => {
  if (pool) await runMigrations(pool);
});

afterAll(async () => {
  await pool?.query("DELETE FROM revoked_sessions WHERE session_id LIKE 'test-%'");
  await pool?.end();
});

// The Postgres store runs only when DATABASE_URL is set (see pg-repository tests).
describe.each([
  { name: "MemorySessionRevocationStore", make: (): SessionRevocationStore => new MemorySessionRevocationStore(), skip: false, shared: false },
  { name: "PgSessionRevocationStore", make: (): SessionRevocationStore => new PgSessionRevocationStore(pool!), skip: !pool, shared: true },
])("$name", ({ make, skip, shared }) => {
  const id = (label: string) => `test-${label}-${Math.random().toString(16).slice(2)}`;
  const at = (hours: number) => new Date(T0.getTime() + hours * HOUR);

  it.skipIf(skip)("lists a session once revoked, and only that one", async () => {
    const store = make();
    const [a, b] = [id("a"), id("b")];
    expect(await store.isRevoked(a)).toBe(false);
    await store.revoke(a, at(8), at(0));
    expect(await store.isRevoked(a)).toBe(true);
    expect(await store.isRevoked(b)).toBe(false);
  });

  it.skipIf(skip)("accepts the same session twice", async () => {
    const store = make();
    const a = id("a");
    await store.revoke(a, at(8), at(0));
    await store.revoke(a, at(8), at(1));
    expect(await store.isRevoked(a)).toBe(true);
  });

  // Memory instances share nothing.
  it.skipIf(skip || !shared)("is read by another instance over the same data", async () => {
    const a = id("a");
    await make().revoke(a, at(8), at(0));
    expect(await make().isRevoked(a)).toBe(true);
  });

  it.skipIf(skip)("prunes entries whose sessions have expired, and keeps the rest", async () => {
    const store = make();
    const [short, long, next] = [id("short"), id("long"), id("next")];
    await store.revoke(short, at(1), at(0));
    await store.revoke(long, at(8), at(0));
    await store.revoke(next, at(10), at(2));
    expect(await store.isRevoked(short)).toBe(false);
    expect(await store.isRevoked(long)).toBe(true);
    expect(await store.isRevoked(next)).toBe(true);
  });

  it.skipIf(skip)("does not keep a session that has already expired", async () => {
    const store = make();
    const a = id("a");
    await store.revoke(a, at(1), at(1));
    expect(await store.isRevoked(a)).toBe(false);
  });
});
