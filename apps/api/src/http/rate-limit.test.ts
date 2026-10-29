import { describe, expect, it } from "vitest";
import type { FastifyInstance, InjectOptions } from "fastify";
import { buildApp } from "../app.js";
import {
  DEFAULT_RATE_LIMITS,
  LIMITED_ROUTES,
  loadRateLimitConfig,
  parseTrustProxy,
  type RateLimitConfig,
} from "./rate-limit.js";

const LIMITS: RateLimitConfig = { enabled: true, max: 5, uploadMax: 2, authMax: 3 };
const SESSION_SECRET = "a-test-session-secret-of-some-length";
const ADDRESS = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

async function statuses(app: FastifyInstance, n: number, request: InjectOptions): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((await app.inject(request)).statusCode);
  return out;
}

const chain: InjectOptions = { method: "GET", url: "/api/chain" };
const upload: InjectOptions = {
  method: "POST",
  url: "/api/contracts",
  headers: { "content-type": "application/json" },
  payload: "{}",
};
const nonce: InjectOptions = { method: "POST", url: "/api/auth/nonce", payload: { address: ADDRESS } };

describe("rate limiting", () => {
  it("is off when no config is passed", async () => {
    const app = buildApp();
    expect(await statuses(app, 8, chain)).not.toContain(429);
  });

  it("is off when disabled", async () => {
    const app = buildApp({ rateLimit: { ...LIMITS, enabled: false } });
    expect(await statuses(app, 8, chain)).not.toContain(429);
  });

  it("answers 429 with a JSON error and Retry-After past the global limit", async () => {
    const app = buildApp({ rateLimit: LIMITS });
    expect(await statuses(app, 5, chain)).toEqual([200, 200, 200, 200, 200]);

    const res = await app.inject(chain);
    expect(res.statusCode).toBe(429);
    expect(res.headers["retry-after"]).toBeDefined();
    expect(res.json()).toEqual({ statusCode: 429, error: expect.stringMatching(/^Too many requests; try again in \d+ seconds$/) });
  });

  it("never limits /health", async () => {
    const app = buildApp({ rateLimit: LIMITS });
    expect(await statuses(app, 10, { method: "GET", url: "/health" })).not.toContain(429);
  });

  it("gives upload routes their own, stricter limit", async () => {
    const app = buildApp({ rateLimit: LIMITS });
    // Rejected uploads count too: the limit is on attempts, not successes.
    expect(await statuses(app, 3, upload)).toEqual([400, 400, 429]);
    // ...and do not use up the global budget.
    expect(await statuses(app, 5, chain)).not.toContain(429);
  });

  it("counts each upload route separately", async () => {
    const app = buildApp({ rateLimit: LIMITS });
    const poc: InjectOptions = { ...upload, url: "/api/auditor/poc" };
    expect(await statuses(app, 3, upload)).toEqual([400, 400, 429]);
    const pocStatuses = await statuses(app, 3, poc);
    expect(pocStatuses.slice(0, 2)).not.toContain(429);
    expect(pocStatuses[2]).toBe(429);
  });

  it("gives sign-in routes their own limit", async () => {
    const app = buildApp({ rateLimit: LIMITS, sessionSecret: SESSION_SECRET });
    expect(await statuses(app, 4, nonce)).toEqual([200, 200, 200, 429]);
    const login: InjectOptions = { method: "POST", url: "/api/auth/login", payload: {} };
    expect(await statuses(app, 4, login)).toEqual([400, 400, 400, 429]);
  });

  it("counts each client IP separately", async () => {
    const app = buildApp({ rateLimit: LIMITS });
    const a = { ...upload, remoteAddress: "10.0.0.1" };
    const b = { ...upload, remoteAddress: "10.0.0.2" };
    expect(await statuses(app, 3, a)).toEqual([400, 400, 429]);
    expect(await statuses(app, 1, b)).toEqual([400]);
  });

  it("ignores X-Forwarded-For unless a proxy is trusted", async () => {
    const app = buildApp({ rateLimit: LIMITS });
    const spoofed = (ip: string) => ({ ...upload, headers: { ...upload.headers, "x-forwarded-for": ip } });
    expect(await statuses(app, 2, spoofed("1.1.1.1"))).toEqual([400, 400]);
    expect(await statuses(app, 1, spoofed("2.2.2.2"))).toEqual([429]);
  });

  it("keys on the client IP the trusted proxy appended", async () => {
    // inject() connects from 127.0.0.1, standing in for the gateway pod.
    const app = buildApp({ rateLimit: LIMITS, trustProxy: ["127.0.0.0/8"] });
    // A client-sent X-Forwarded-For entry comes first; the gateway appends
    // the address it saw, and only that last hop is trusted.
    const via = (client: string, spoofed: string) => ({
      ...upload,
      headers: { ...upload.headers, "x-forwarded-for": `${spoofed}, ${client}` },
    });
    expect(await statuses(app, 2, via("203.0.113.7", "1.1.1.1"))).toEqual([400, 400]);
    expect(await statuses(app, 1, via("203.0.113.7", "2.2.2.2"))).toEqual([429]);
    expect(await statuses(app, 1, via("203.0.113.8", "1.1.1.1"))).toEqual([400]);
  });

  it("every route in LIMITED_ROUTES exists", async () => {
    const app = buildApp({ rateLimit: LIMITS, sessionSecret: SESSION_SECRET });
    await app.ready();
    for (const key of Object.keys(LIMITED_ROUTES)) {
      const [method, url] = key.split(" ") as [string, string];
      expect(app.hasRoute({ method: method as "POST", url }), key).toBe(true);
    }
  });
});

describe("loadRateLimitConfig", () => {
  it("defaults to on with the default limits", () => {
    expect(loadRateLimitConfig({})).toEqual(DEFAULT_RATE_LIMITS);
    expect(DEFAULT_RATE_LIMITS.enabled).toBe(true);
  });

  it("reads overrides and ignores invalid numbers", () => {
    expect(
      loadRateLimitConfig({
        RATE_LIMIT_ENABLED: "false",
        RATE_LIMIT_MAX: "100",
        RATE_LIMIT_UPLOAD_MAX: "0",
        RATE_LIMIT_AUTH_MAX: "lots",
      }),
    ).toEqual({ enabled: false, max: 100, uploadMax: DEFAULT_RATE_LIMITS.uploadMax, authMax: DEFAULT_RATE_LIMITS.authMax });
  });
});

describe("parseTrustProxy", () => {
  it("trusts nothing by default", () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy(" ")).toBe(false);
    expect(parseTrustProxy("false")).toBe(false);
  });

  it("reads a list of proxy addresses", () => {
    expect(parseTrustProxy("192.168.0.0/16, 127.0.0.1,fd00::/8")).toEqual([
      "192.168.0.0/16",
      "127.0.0.1",
      "fd00::/8",
    ]);
  });

  it.each(["true", "1", "192.168.0.0/33", "10.0.0.0/8/1", "gateway"])("refuses %s", (value) => {
    expect(() => parseTrustProxy(value)).toThrow(/proxy IPs or CIDRs/);
  });
});
