import type { FastifyInstance } from "fastify";
import { isIP } from "node:net";
import rateLimit from "@fastify/rate-limit";
import { parseBoolEnv, parseIntEnv } from "../env.js";

/** Per-client-IP request limits. Counters live in each API process, so with
 * several replicas a client can get up to `replicas ×` the limit. */
export interface RateLimitConfig {
  enabled: boolean;
  /** Requests per minute to any route without its own limit below. */
  max: number;
  /** Requests per 10 minutes to each upload route. Contract uploads start an
   * LLM analysis and PoC uploads run in the sandbox, so they cost money. */
  uploadMax: number;
  /** Requests per minute to each sign-in route. */
  authMax: number;
}

export const DEFAULT_RATE_LIMITS: RateLimitConfig = {
  enabled: true,
  // A flood guard only: one browser tab polls 60-90 req/min, and a campus
  // NAT can put many users behind one IP. The costly routes have their own.
  max: 3000,
  uploadMax: 20,
  authMax: 60,
};

const MINUTE_MS = 60_000;

/** Routes with their own, stricter limit, as "METHOD /path". Each one is
 * counted separately from the others and from the global limit. */
export const LIMITED_ROUTES: Readonly<Record<string, "upload" | "auth">> = {
  "POST /api/contracts": "upload",
  "POST /api/auditor/poc": "upload",
  "POST /api/auth/nonce": "auth",
  "POST /api/auth/login": "auth",
};

/** RATE_LIMIT_ENABLED (default true), RATE_LIMIT_MAX, RATE_LIMIT_UPLOAD_MAX
 * and RATE_LIMIT_AUTH_MAX. Invalid numbers fall back to the defaults. */
export function loadRateLimitConfig(env: NodeJS.ProcessEnv): RateLimitConfig {
  return {
    enabled: parseBoolEnv(env.RATE_LIMIT_ENABLED, DEFAULT_RATE_LIMITS.enabled),
    max: parseIntEnv(env.RATE_LIMIT_MAX, DEFAULT_RATE_LIMITS.max),
    uploadMax: parseIntEnv(env.RATE_LIMIT_UPLOAD_MAX, DEFAULT_RATE_LIMITS.uploadMax),
    authMax: parseIntEnv(env.RATE_LIMIT_AUTH_MAX, DEFAULT_RATE_LIMITS.authMax),
  };
}

/** Parses TRUST_PROXY into Fastify's `trustProxy`: a comma-separated list of
 * the proxy IPs or CIDRs (in k8s, the pod CIDR the Gateway's Envoy pods run
 * in) whose X-Forwarded-For entries are believed. Unset or "false" trusts
 * none, so the client is the socket peer. Fastify ignores hop counts, and
 * "true" would trust any X-Forwarded-For a client sends, letting anyone pick
 * their own rate-limit key, so both are refused. */
export function parseTrustProxy(value: string | undefined): false | string[] {
  const v = value?.trim() ?? "";
  if (v === "" || v.toLowerCase() === "false") return false;
  const entries = v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const entry of entries) {
    const [ip, bits, ...rest] = entry.split("/");
    const family = isIP(ip ?? "");
    const maxBits = family === 6 ? 128 : 32;
    const bitsOk = bits === undefined || (/^\d+$/.test(bits) && Number(bits) <= maxBits);
    if (!family || !bitsOk || rest.length > 0) {
      throw new Error(`TRUST_PROXY must list proxy IPs or CIDRs, got "${entry}"`);
    }
  }
  return entries;
}

function retrySeconds(ttlMs: number): number {
  return Math.max(1, Math.ceil(ttlMs / 1000));
}

/** Registers the limiter. Call it before any route is declared, and declare
 * routes in a plugin registered after it: the limiter attaches to routes as
 * they are added, and only once it has loaded. */
export function registerRateLimit(app: FastifyInstance, config: RateLimitConfig): void {
  if (!config.enabled) return;

  // Runs before the limiter's own onRoute hook, so it sees these limits.
  app.addHook("onRoute", (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    const kind = methods.map((m) => LIMITED_ROUTES[`${m} ${route.url}`]).find(Boolean);
    if (!kind || route.config?.rateLimit === false) return;
    const rule =
      kind === "upload"
        ? { max: config.uploadMax, timeWindow: 10 * MINUTE_MS }
        : { max: config.authMax, timeWindow: MINUTE_MS };
    route.config = { ...route.config, rateLimit: rule };
  });

  void app.register(rateLimit, {
    global: true,
    max: config.max,
    timeWindow: MINUTE_MS,
    // The limiter throws what this returns; statusCode keeps it a 429.
    errorResponseBuilder: (_request, context) => ({
      statusCode: context.statusCode,
      error: `Too many requests; try again in ${retrySeconds(context.ttl)} seconds`,
    }),
  });
}
