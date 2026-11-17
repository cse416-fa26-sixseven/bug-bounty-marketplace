import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { getAddress, isAddress, isAddressEqual, verifyMessage, type Address, type Hex } from "viem";
import { createSiweMessage, parseSiweMessage, validateSiweMessage } from "viem/siwe";
import { MemorySessionRevocationStore, type SessionRevocationStore } from "./revocation-store.js";

export const SESSION_COOKIE = "bbm_session";
const NONCE_TTL_MS = 5 * 60_000;
const SESSION_TTL_MS = 8 * 3_600_000;
/** Open sign-in requests kept per address; older ones are dropped. */
const MAX_NONCES_PER_ADDRESS = 5;
/** The SIWE statement every sign-in message carries. */
export const SIGN_IN_STATEMENT = "Sign in to BountyGuard.";

/** Where a sign-in happens: the SIWE `domain` (host[:port]) and `uri` (origin). */
export interface SignInOrigin {
  domain: string;
  uri: string;
}

export interface AuthOptions {
  /** HMAC secret for session cookies. */
  secret: string;
  now: () => Date;
  /** The chain the API runs on: every message names it and login checks it. */
  chainId: number;
  /** AUTH_ORIGIN, or null to take the origin from each request (dev only). */
  origin: string | null;
  /** Add Secure to the session cookie. */
  secureCookie: boolean;
  /** Sessions ended by logout. Defaults to an in-memory store, which forgets
   * them on restart; `index.ts` passes the Postgres one when DATABASE_URL is set. */
  revocations?: SessionRevocationStore;
}

/** What a valid session cookie carries. */
interface Session {
  address: Address;
  /** Random id naming this sign-in, so logout can end it alone. */
  id: string;
  expiresAt: Date;
}

const SESSION_ID_PATTERN = /^[0-9a-f]{32}$/;

export type LoginResult = { ok: true; address: Address; token: string } | { ok: false; reason: string };

function originFromUrl(value: string): SignInOrigin | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return { domain: url.host, uri: url.origin };
  } catch {
    return null;
  }
}

/**
 * Sign-In with Ethereum (EIP-4361). POST /api/auth/nonce issues a SIWE message
 * naming the web app's domain and URI, the address, the API's chain, a
 * single-use nonce and a 5-minute expiry; POST /api/auth/login checks each of
 * those against what was issued, and the signature against the address. A
 * session is an HMAC-signed cookie (address + expiry + a random session id)
 * that lives 8 hours. POST /api/auth/logout records the session id in the
 * revocation store, and every session check looks it up there, so a copy of
 * the cookie is refused from then on (across restarts and replicas when the
 * store is Postgres). Other sessions of the same address are not affected.
 * Cookies signed before sessions had an id (address + expiry only) are
 * refused, since they could not be revoked: their holders sign in again.
 * Nonces are held in memory, so sign-in needs a single API replica (as the
 * demo runs).
 */
export class Auth {
  private readonly nonces = new Map<string, { address: Address; origin: SignInOrigin; expiresAt: number }>();
  private readonly secret: string;
  private readonly now: () => Date;
  private readonly chainId: number;
  private readonly fixedOrigin: SignInOrigin | null;
  private readonly secureCookie: boolean;
  private readonly revocations: SessionRevocationStore;

  constructor(options: AuthOptions) {
    this.secret = options.secret;
    this.now = options.now;
    this.chainId = options.chainId;
    this.fixedOrigin = options.origin ? originFromUrl(options.origin) : null;
    this.secureCookie = options.secureCookie;
    this.revocations = options.revocations ?? new MemorySessionRevocationStore();
  }

  /**
   * The domain and URI a request signs in for: AUTH_ORIGIN when configured
   * (null when the request's Origin header names another site).
   * Otherwise the browser's Origin header (sent on every POST, and passed on
   * unchanged by the web app's /api proxy), else the Host (X-Forwarded-Host
   * only from a TRUST_PROXY proxy, as Fastify's request.host does).
   */
  originOf(request: FastifyRequest): SignInOrigin | null {
    const header = request.headers.origin;
    const fromHeader = typeof header === "string" && header !== "null" ? originFromUrl(header) : null;
    if (this.fixedOrigin) {
      // A browser on another site sends its own Origin: refuse it. Clients
      // without one (scripts) get the configured origin.
      if (fromHeader && fromHeader.uri !== this.fixedOrigin.uri) return null;
      return this.fixedOrigin;
    }
    if (fromHeader) return fromHeader;
    return request.host ? originFromUrl(`${request.protocol}://${request.host}`) : null;
  }

  /** A SIWE message for `address` at `origin`, or null when the origin's host
   * is not a valid SIWE domain (e.g. a bare docker service name). */
  issueNonce(address: string, origin: SignInOrigin): { nonce: string; message: string } | null {
    const checksummed = getAddress(address);
    const now = this.now();
    const nonce = randomBytes(16).toString("hex");
    let message: string;
    try {
      message = createSiweMessage({
        domain: origin.domain,
        address: checksummed,
        statement: SIGN_IN_STATEMENT,
        uri: origin.uri,
        version: "1",
        chainId: this.chainId,
        nonce,
        issuedAt: now,
        expirationTime: new Date(now.getTime() + NONCE_TTL_MS),
      });
    } catch {
      return null;
    }
    this.pruneNonces();
    const open = [...this.nonces].filter(([, entry]) => entry.address === checksummed);
    for (const [stale] of open.slice(0, Math.max(0, open.length - MAX_NONCES_PER_ADDRESS + 1))) {
      this.nonces.delete(stale);
    }
    this.nonces.set(nonce, { address: checksummed, origin, expiresAt: now.getTime() + NONCE_TTL_MS });
    return { nonce, message };
  }

  /**
   * Verifies a signed SIWE message. Its nonce must be open, and its domain,
   * URI, address and chain must be the ones that nonce was issued for; the
   * login request must come from that same domain. A nonce is spent when a
   * signature over it verifies. `claimedAddress`, when sent, must match.
   */
  async login(
    message: string,
    signature: Hex,
    origin: SignInOrigin | null,
    claimedAddress?: string,
  ): Promise<LoginResult> {
    const fail = (reason: string): LoginResult => ({ ok: false, reason });
    let parsed: ReturnType<typeof parseSiweMessage>;
    try {
      parsed = parseSiweMessage(message);
    } catch {
      return fail("not a sign-in message");
    }
    const entry = parsed.nonce ? this.nonces.get(parsed.nonce) : undefined;
    if (!parsed.nonce || !entry) return fail("no open sign-in request for this message");
    const now = this.now();
    if (entry.expiresAt <= now.getTime()) {
      this.nonces.delete(parsed.nonce);
      return fail("the sign-in request expired");
    }
    if (
      parsed.domain !== entry.origin.domain ||
      parsed.uri !== entry.origin.uri ||
      origin?.domain !== entry.origin.domain
    ) {
      return fail("the message is for another site");
    }
    if (parsed.version !== "1" || parsed.chainId !== this.chainId) return fail("the message is for another chain");
    if (
      !validateSiweMessage({
        message: parsed,
        address: entry.address,
        domain: entry.origin.domain,
        nonce: parsed.nonce,
        time: now,
      })
    ) {
      return fail("the message is for another account or has expired");
    }
    if (claimedAddress !== undefined && !(isAddress(claimedAddress) && isAddressEqual(claimedAddress, entry.address))) {
      return fail("the message is for another account");
    }
    // Claim the nonce before awaiting, so two concurrent logins with the same
    // signed message cannot both pass; give it back if the signature fails.
    const nonce = parsed.nonce;
    this.nonces.delete(nonce);
    const valid = await verifyMessage({ address: entry.address, message, signature }).catch(() => false);
    if (!valid) {
      this.nonces.set(nonce, entry);
      return fail("the signature does not match the message's address");
    }
    return { ok: true, address: entry.address, token: this.sign(entry.address) };
  }

  /**
   * The signed-in address from the request's session cookie, or null. The
   * cookie must be signed, unexpired and not logged out. Rejects (a 500) when
   * the revocation store cannot be read, rather than letting the session in.
   */
  async sessionAddress(request: FastifyRequest): Promise<Address | null> {
    const session = this.readSession(request);
    if (!session || (await this.revocations.isRevoked(session.id))) return null;
    return session.address;
  }

  /** The signed-in address, or sends 401 and returns undefined. */
  async requireSession(request: FastifyRequest, reply: FastifyReply): Promise<Address | undefined> {
    const address = await this.sessionAddress(request);
    if (!address) {
      void reply.code(401).send({ error: "sign in first" });
      return undefined;
    }
    return address;
  }

  /**
   * Ends the session in the request's cookie, so that cookie (and any copy of
   * it) is refused from now on. Does nothing without a signed, unexpired
   * session cookie.
   */
  async revokeSession(request: FastifyRequest): Promise<void> {
    const session = this.readSession(request);
    if (session) await this.revocations.revoke(session.id, session.expiresAt, this.now());
  }

  /** The signed, unexpired session in the request's cookie, or null. Does not
   * check for logout. */
  private readSession(request: FastifyRequest): Session | null {
    const token = readCookie(request.headers.cookie, SESSION_COOKIE);
    if (!token) return null;
    const [payload, mac] = token.split(".");
    if (!payload || !mac || !safeEqual(mac, this.mac(payload))) return null;
    // address|expiry|id. Cookies from before sessions had an id have two
    // fields and are refused: they could not be revoked.
    const fields = Buffer.from(payload, "base64url").toString("utf8").split("|");
    if (fields.length !== 3) return null;
    const [address, expires, id] = fields as [string, string, string];
    const expiresAt = Number(expires);
    if (!isAddress(address) || !(expiresAt > this.now().getTime()) || !SESSION_ID_PATTERN.test(id)) return null;
    return { address: getAddress(address), id, expiresAt: new Date(expiresAt) };
  }

  sessionCookie(token: string): string {
    return `${SESSION_COOKIE}=${token}; ${this.cookieAttributes()}; Max-Age=${SESSION_TTL_MS / 1000}`;
  }

  clearedCookie(): string {
    return `${SESSION_COOKIE}=; ${this.cookieAttributes()}; Max-Age=0`;
  }

  private cookieAttributes(): string {
    return `Path=/; HttpOnly;${this.secureCookie ? " Secure;" : ""} SameSite=Lax`;
  }

  private sign(address: Address): string {
    const id = randomBytes(16).toString("hex");
    const payload = Buffer.from(`${address}|${this.now().getTime() + SESSION_TTL_MS}|${id}`).toString("base64url");
    return `${payload}.${this.mac(payload)}`;
  }

  private mac(payload: string): string {
    return createHmac("sha256", this.secret).update(payload).digest("base64url");
  }

  private pruneNonces(): void {
    const now = this.now().getTime();
    for (const [nonce, entry] of this.nonces) if (entry.expiresAt <= now) this.nonces.delete(nonce);
  }
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=") || null;
  }
  return null;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export type ActorResult = { ok: true; id: string | undefined } | { ok: false };

/**
 * Who a request acts for. Without sign-in (no chain configured) it is the id
 * the client sent, unchanged. With sign-in it is the session's address: no
 * session is 401, and a client-sent id for someone else is 403.
 */
export async function resolveActor(
  auth: Auth | null,
  request: FastifyRequest,
  reply: FastifyReply,
  claimed: unknown,
): Promise<ActorResult> {
  if (!auth) return { ok: true, id: typeof claimed === "string" && claimed ? claimed : undefined };
  const address = await auth.requireSession(request, reply);
  if (!address) return { ok: false };
  if (typeof claimed === "string" && claimed && claimed.toLowerCase() !== address.toLowerCase()) {
    void reply.code(403).send({ error: "you can only act for your signed-in wallet" });
    return { ok: false };
  }
  return { ok: true, id: address };
}
