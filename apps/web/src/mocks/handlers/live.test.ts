import { describe, expect, it } from "vitest";
import { developerHandlers } from "./developer";
import { auditorHandlers } from "./auditor";
import { arbiterHandlers } from "./arbiter";
import { chainHandlers } from "./chain";
import { LIVE_CHAIN_ROUTES, LIVE_ROUTES, selectHandlers } from "./live";

const all = [...developerHandlers, ...auditorHandlers, ...arbiterHandlers];

function routes(handlers: typeof all): string[] {
  return handlers.map((h) => `${String(h.info.method)} ${String(h.info.path)}`);
}

describe("selectHandlers", () => {
  it("keeps every mock handler when live mode is off", () => {
    expect(selectHandlers(all, false)).toEqual(all);
  });

  it("drops exactly the live pipeline routes when live mode is on", () => {
    const kept = routes(selectHandlers(all, true));
    const dropped = routes(all).filter((r) => !kept.includes(r));
    expect(dropped.sort()).toEqual(
      [
        "POST */api/contracts",
        "GET */api/contracts",
        "GET */api/contracts/:id",
        "GET */api/contracts/:id/findings",
        "GET */api/contracts/:id/analysis",
        "GET */api/contracts/:id/bounty",
        "GET */api/auditor/queue",
        "POST */api/auditor/claim",
        "POST */api/auditor/poc",
      ].sort(),
    );
  });

  it("still mocks stake, profile, disputes and the arbiter", () => {
    const kept = routes(selectHandlers(all, true));
    expect(kept).toContain("POST */api/auditor/stake");
    expect(kept).toContain("GET */api/auditor/profile");
    expect(kept).toContain("POST */api/findings/:id/dispute");
    expect(kept).toContain("GET */api/arbiter/disputes");
  });

  it("lists the raw-output route as live even though it has no mock", () => {
    expect(LIVE_ROUTES).toContainEqual({ method: "GET", path: "/api/findings/:id/raw" });
    expect(LIVE_ROUTES).toHaveLength(10);
  });
});

describe("selectHandlers with the chain", () => {
  const withChain = [...chainHandlers, ...all];

  it("pipeline live mode keeps the chain mocked, so the app never signs against a half-mocked API", () => {
    expect(routes(selectHandlers(withChain, true))).toContain("GET */api/chain");
  });

  it("chain live mode sends GET /api/chain to the API", () => {
    expect(routes(selectHandlers(withChain, true, true))).not.toContain("GET */api/chain");
  });

  it("chain live mode drops every lifecycle route too", () => {
    const kept = routes(selectHandlers(withChain, true, true));
    for (const route of [
      "POST */api/contracts/:id/cancel",
      "POST */api/contracts/:id/reclaim",
      "GET */api/auditor/profile",
      "POST */api/findings/:id/dispute",
      "POST */api/findings/:id/false-positive",
      "GET */api/arbiter/disputes",
      "POST */api/arbiter/disputes/:id/rule",
    ]) {
      expect(kept).not.toContain(route);
    }
    expect(LIVE_CHAIN_ROUTES.length).toBeGreaterThan(LIVE_ROUTES.length);
  });

  it("pipeline live mode keeps the lifecycle routes mocked", () => {
    expect(routes(selectHandlers(withChain, true))).toContain("GET */api/auditor/profile");
  });
});
