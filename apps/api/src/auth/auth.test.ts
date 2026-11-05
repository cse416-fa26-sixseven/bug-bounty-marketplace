import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createSiweMessage, parseSiweMessage } from "viem/siwe";
import { buildApp, type AppOptions } from "../app.js";
import type { ChainConfig } from "../chain/config.js";

const AUDITOR = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
const DEVELOPER = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const SECRET = "test-session-secret";
const ORIGIN = "http://localhost:3000";

const SEPOLIA: ChainConfig = {
  rpcUrl: "http://rpc.invalid",
  publicRpcUrl: null,
  chainId: 11155111,
  operatorPrivateKey: `0x${"11".repeat(32)}`,
  auditorStakingAddress: "0x5FbDB2315678afecb367f032d93F642f64180aa3" as Address,
  bountyEscrowAddress: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512" as Address,
  disputeResolutionAddress: "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0" as Address,
  arbiterAddress: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address,
  challengeWindowSeconds: 60,
};

function setup(options: Partial<AppOptions> = {}) {
  const clock = { now: new Date("2026-10-20T12:00:00.000Z") };
  const app = buildApp({ sessionSecret: SECRET, now: () => clock.now, ...options });
  async function nonce(address: string, headers: Record<string, string> = { origin: ORIGIN }) {
    const res = await app.inject({ method: "POST", url: "/api/auth/nonce", payload: { address }, headers });
    expect(res.statusCode).toBe(200);
    return res.json() as { nonce: string; message: string };
  }
  async function login(
    message: string,
    signature: string,
    headers: Record<string, string> = { origin: ORIGIN },
    extra: Record<string, unknown> = {},
  ) {
    return app.inject({ method: "POST", url: "/api/auth/login", payload: { message, signature, ...extra }, headers });
  }
  function cookieOf(res: { headers: Record<string, unknown> }): string {
    return String(res.headers["set-cookie"]).split(";")[0]!;
  }
  return { app, clock, nonce, login, cookieOf };
}

/** The issued message with some fields changed, as a client could send it. */
function rewrite(message: string, changes: Partial<Parameters<typeof createSiweMessage>[0]>): string {
  const parsed = parseSiweMessage(message);
  return createSiweMessage({ ...(parsed as Parameters<typeof createSiweMessage>[0]), ...changes });
}

describe("Sign-In with Ethereum (EIP-4361)", () => {
  it("issues a SIWE message bound to the page origin, the chain, the nonce and a 5-minute expiry", async () => {
    const { clock, nonce } = setup();
    const { nonce: n, message } = await nonce(AUDITOR.address.toLowerCase());
    expect(message.startsWith(`localhost:3000 wants you to sign in with your Ethereum account:\n${AUDITOR.address}\n`)).toBe(true);
    expect(parseSiweMessage(message)).toEqual({
      domain: "localhost:3000",
      address: AUDITOR.address,
      statement: "Sign in to BountyGuard.",
      uri: ORIGIN,
      version: "1",
      chainId: 31337,
      nonce: n,
      issuedAt: clock.now,
      expirationTime: new Date(clock.now.getTime() + 5 * 60_000),
    });
  });

  it("uses the configured chain's id", async () => {
    const { nonce } = setup({ chainConfig: SEPOLIA });
    const { message } = await nonce(AUDITOR.address);
    expect(parseSiweMessage(message).chainId).toBe(11155111);
  });

  it("uses AUTH_ORIGIN when configured, whatever the request says", async () => {
    const { nonce, login } = setup({ authConfig: { origin: "https://bountyguard.example", secureCookie: true } });
    const { message } = await nonce(AUDITOR.address, { origin: "https://evil.example" });
    expect(parseSiweMessage(message)).toMatchObject({ domain: "bountyguard.example", uri: "https://bountyguard.example" });
    const res = await login(message, await AUDITOR.signMessage({ message }), {});
    expect(res.statusCode).toBe(200);
  });

  it("without an Origin header falls back to Host, and trusts X-Forwarded-Host only from a trusted proxy", async () => {
    const plain = setup();
    const direct = await plain.nonce(AUDITOR.address, { host: "api.local:3001", "x-forwarded-host": "spoofed.example" });
    expect(parseSiweMessage(direct.message)).toMatchObject({ domain: "api.local:3001", uri: "http://api.local:3001" });

    const proxied = setup({ trustProxy: ["127.0.0.1"] });
    const viaProxy = await proxied.nonce(AUDITOR.address, {
      host: "api:3001",
      "x-forwarded-host": "localhost:3000",
      "x-forwarded-proto": "http",
    });
    expect(parseSiweMessage(viaProxy.message)).toMatchObject({ domain: "localhost:3000", uri: ORIGIN });
  });

  it("signs in with a valid signature and /me returns the address", async () => {
    const { app, nonce, login, cookieOf } = setup();
    const { message } = await nonce(AUDITOR.address);
    const res = await login(message, await AUDITOR.signMessage({ message }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ address: AUDITOR.address });
    const cookie = String(res.headers["set-cookie"]);
    expect(cookie).toMatch(/bbm_session=.*HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).not.toMatch(/Secure/i);
    const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: cookieOf(res) } });
    expect(me.json()).toEqual({ address: AUDITOR.address });
  });

  it("marks the session cookie Secure when configured", async () => {
    const { app, nonce, login } = setup({ authConfig: { origin: null, secureCookie: true } });
    const { message } = await nonce(AUDITOR.address);
    const res = await login(message, await AUDITOR.signMessage({ message }));
    expect(String(res.headers["set-cookie"])).toMatch(/HttpOnly; Secure; SameSite=Lax/);
    const out = await app.inject({ method: "POST", url: "/api/auth/logout" });
    expect(String(out.headers["set-cookie"])).toMatch(/Secure/);
  });

  it("rejects a signature from another account", async () => {
    const { nonce, login } = setup();
    const { message } = await nonce(AUDITOR.address);
    expect((await login(message, await DEVELOPER.signMessage({ message }))).statusCode).toBe(401);
  });

  it("rejects a message for another domain", async () => {
    const { nonce, login } = setup();
    const { message } = await nonce(AUDITOR.address);
    const forged = rewrite(message, { domain: "evil.example", uri: "https://evil.example" });
    expect((await login(forged, await AUDITOR.signMessage({ message: forged }))).statusCode).toBe(401);
  });

  it("rejects a login sent from another origin than the message names", async () => {
    const { nonce, login } = setup();
    const { message } = await nonce(AUDITOR.address);
    const res = await login(message, await AUDITOR.signMessage({ message }), { origin: "https://evil.example" });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a message for another chain", async () => {
    const { nonce, login } = setup();
    const { message } = await nonce(AUDITOR.address);
    const forged = rewrite(message, { chainId: 1 });
    expect((await login(forged, await AUDITOR.signMessage({ message: forged }))).statusCode).toBe(401);
  });

  it("rejects a message for another address than the nonce was issued to", async () => {
    const { nonce, login } = setup();
    const { message } = await nonce(AUDITOR.address);
    const forged = rewrite(message, { address: DEVELOPER.address });
    expect((await login(forged, await DEVELOPER.signMessage({ message: forged }))).statusCode).toBe(401);
  });

  it("rejects a body address that is not the message's", async () => {
    const { nonce, login } = setup();
    const { message } = await nonce(AUDITOR.address);
    const res = await login(message, await AUDITOR.signMessage({ message }), { origin: ORIGIN }, { address: DEVELOPER.address });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a message that is not SIWE", async () => {
    const { login } = setup();
    const message = "BountyGuard sign-in\nNonce: abcdefgh12345678";
    expect((await login(message, await AUDITOR.signMessage({ message }))).statusCode).toBe(401);
  });

  it("rejects a reused nonce", async () => {
    const { nonce, login } = setup();
    const { message } = await nonce(AUDITOR.address);
    const signature = await AUDITOR.signMessage({ message });
    expect((await login(message, signature)).statusCode).toBe(200);
    expect((await login(message, signature)).statusCode).toBe(401);
  });

  it("rejects an expired nonce", async () => {
    const { clock, nonce, login } = setup();
    const { message } = await nonce(AUDITOR.address);
    clock.now = new Date(clock.now.getTime() + 6 * 60_000);
    expect((await login(message, await AUDITOR.signMessage({ message }))).statusCode).toBe(401);
  });

  it("rejects a message whose expiration time has passed even if the nonce is still open", async () => {
    const { clock, nonce, login } = setup();
    const { message } = await nonce(AUDITOR.address);
    const forged = rewrite(message, { expirationTime: new Date(clock.now.getTime() - 1000) });
    expect((await login(forged, await AUDITOR.signMessage({ message: forged }))).statusCode).toBe(401);
  });

  it("rejects a tampered or expired session cookie", async () => {
    const { app, clock, nonce, login, cookieOf } = setup();
    const { message } = await nonce(AUDITOR.address);
    const cookie = cookieOf(await login(message, await AUDITOR.signMessage({ message })));
    const tampered = cookie.slice(0, -2) + (cookie.endsWith("aa") ? "bb" : "aa");
    expect((await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: tampered } })).statusCode).toBe(401);
    clock.now = new Date(clock.now.getTime() + 9 * 3_600_000);
    expect((await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } })).statusCode).toBe(401);
  });

  it("keeps only the newest open sign-in requests per address", async () => {
    const { nonce, login } = setup();
    const first = await nonce(AUDITOR.address);
    for (let i = 0; i < 5; i += 1) await nonce(AUDITOR.address);
    expect((await login(first.message, await AUDITOR.signMessage({ message: first.message }))).statusCode).toBe(401);
    const latest = await nonce(AUDITOR.address);
    expect((await login(latest.message, await AUDITOR.signMessage({ message: latest.message }))).statusCode).toBe(200);
  });

  it("requires a message and a hex signature", async () => {
    const { app } = setup();
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { address: AUDITOR.address, signature: "0x00" } });
    expect(res.statusCode).toBe(400);
  });

  it("logs out by clearing the cookie", async () => {
    const { app } = setup();
    const res = await app.inject({ method: "POST", url: "/api/auth/logout" });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers["set-cookie"])).toMatch(/bbm_session=;.*Max-Age=0/i);
    expect(String(res.headers["set-cookie"])).not.toMatch(/Secure/i);
  });
});
