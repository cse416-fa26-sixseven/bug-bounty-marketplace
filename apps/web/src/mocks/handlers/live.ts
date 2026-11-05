import type { RequestHandler } from "msw";

type LiveRoute = { method: "GET" | "POST" | "PUT"; path: string };

/**
 * Routes served by the real API in live pipeline mode
 * (NEXT_PUBLIC_LIVE_PIPELINE=enabled together with NEXT_PUBLIC_API_MOCKING).
 * Their MSW handlers are dropped, so the request reaches the Next server,
 * whose /api proxy (src/proxy.ts, API_INTERNAL_URL) forwards it to the
 * Fastify API. Everything else (stake, profile, disputes, arbiter, ...) stays
 * mocked. NEXT_PUBLIC_API_MOCKING=disabled sends every route to the API.
 */
export const LIVE_ROUTES: ReadonlyArray<LiveRoute> = [
  { method: "POST", path: "/api/contracts" },
  { method: "GET", path: "/api/contracts" },
  { method: "GET", path: "/api/contracts/:id" },
  { method: "GET", path: "/api/contracts/:id/findings" },
  { method: "GET", path: "/api/contracts/:id/analysis" },
  // The terms the developer funds on-chain: the mock DB does not know real contracts.
  { method: "GET", path: "/api/contracts/:id/bounty" },
  { method: "GET", path: "/api/findings/:id/raw" },
  { method: "GET", path: "/api/auditor/queue" },
  { method: "POST", path: "/api/auditor/claim" },
  { method: "POST", path: "/api/auditor/poc" },
  // Served with the pipeline routes, with or without a chain.
  { method: "POST", path: "/api/auditor/findings" },
  { method: "PUT", path: "/api/findings/:id/note" },
];

/**
 * Routes the API serves only with a chain configured (pnpm stack:demo). They
 * go to the real API when NEXT_PUBLIC_LIVE_CHAIN=enabled as well, so the
 * pipeline-only live mode keeps working against an API without a chain.
 */
export const LIVE_CHAIN_ROUTES: ReadonlyArray<LiveRoute> = [
  ...LIVE_ROUTES,
  // Only here: a real chain description switches the app to signing
  // transactions, which needs every lifecycle route below to be real too.
  { method: "GET", path: "/api/chain" },
  { method: "POST", path: "/api/contracts/:id/funded" },
  { method: "POST", path: "/api/contracts/:id/cancel" },
  { method: "POST", path: "/api/contracts/:id/reclaim" },
  { method: "GET", path: "/api/auditor/profile" },
  { method: "POST", path: "/api/findings/:id/false-positive" },
  { method: "POST", path: "/api/findings/:id/dispute" },
  { method: "GET", path: "/api/arbiter/disputes" },
  { method: "POST", path: "/api/arbiter/disputes/:id/rule" },
];

function isLive(
  handler: RequestHandler,
  routes: ReadonlyArray<{ method: string; path: string }>,
): boolean {
  const info = handler.info as { method?: unknown; path?: unknown };
  const path = String(info.path ?? "").replace(/^\*/, "");
  return routes.some((route) => route.method === info.method && route.path === path);
}

/** All handlers when `live` is false; otherwise all but the live routes (and,
 * with `chain`, all but the chain lifecycle routes too). */
export function selectHandlers<H extends RequestHandler>(
  handlers: H[],
  live: boolean,
  chain = false,
): H[] {
  if (!live && !chain) return handlers;
  const routes = chain ? LIVE_CHAIN_ROUTES : LIVE_ROUTES;
  return handlers.filter((handler) => !isLive(handler, routes));
}
