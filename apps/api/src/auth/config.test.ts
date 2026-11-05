import { describe, expect, it } from "vitest";
import { loadAuthConfig } from "./config.js";

describe("loadAuthConfig", () => {
  it("derives the origin per request and sends plain cookies by default", () => {
    expect(loadAuthConfig({})).toEqual({ origin: null, secureCookie: false });
  });

  it("normalises AUTH_ORIGIN and marks cookies Secure for an https origin", () => {
    expect(loadAuthConfig({ AUTH_ORIGIN: "https://BountyGuard.example/" })).toEqual({
      origin: "https://bountyguard.example",
      secureCookie: true,
    });
    expect(loadAuthConfig({ AUTH_ORIGIN: "http://localhost:3000" })).toEqual({
      origin: "http://localhost:3000",
      secureCookie: false,
    });
  });

  it("lets COOKIE_SECURE override the default either way", () => {
    expect(loadAuthConfig({ COOKIE_SECURE: "true" }).secureCookie).toBe(true);
    expect(loadAuthConfig({ AUTH_ORIGIN: "https://bountyguard.example", COOKIE_SECURE: "false" }).secureCookie).toBe(false);
  });

  it("rejects an AUTH_ORIGIN that is not a bare http(s) origin", () => {
    for (const value of ["bountyguard.example", "ftp://bountyguard.example", "https://bountyguard.example/app", "https://x.example?a=1"]) {
      expect(() => loadAuthConfig({ AUTH_ORIGIN: value }), value).toThrow(/AUTH_ORIGIN/);
    }
  });
});
