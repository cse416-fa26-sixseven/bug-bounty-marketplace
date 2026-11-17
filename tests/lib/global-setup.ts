import { env } from "./env.js";

/** Polls `${base}/health` until it answers 200; throws `hint` on timeout. */
async function waitForHealth(base: string, hint: string): Promise<void> {
  const url = `${base}/health`;
  const deadline = Date.now() + Number(process.env.BBM_WAIT_MS ?? 30_000);
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
      lastError = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`System under test is not reachable at ${url} (${String(lastError)}). ${hint}`);
}

/** Fail fast with a clear message when the stack isn't up, instead of every
 * test timing out with ECONNREFUSED. */
export default async function globalSetup(): Promise<void> {
  await waitForHealth(env.apiUrl, "Start it with `pnpm stack:up` or set BBM_API_URL/BBM_WEB_URL.");
  if (env.chain && env.chainApiUrl !== env.apiUrl) {
    await waitForHealth(
      env.chainApiUrl,
      "BBM_CHAIN=1 needs the chain-mode API: start it with `pnpm stack:ci-chain` " +
        "(or `pnpm stack:demo`), or set BBM_CHAIN_API_URL.",
    );
  }
}
