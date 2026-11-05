import { defineConfig, devices } from "@playwright/test";

/**
 * Browser E2E against an already-running web app (no webServer: the target
 * is `pnpm stack:up`, the ACA pipeline-test env, or a preview).
 *
 *   BBM_WEB_URL=https://<web fqdn> pnpm test:e2e
 */
const baseURL = (process.env.BBM_WEB_URL ?? "http://localhost:3000").replace(/\/+$/, "");
const ci = !!process.env.CI;

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  outputDir: "test-results",
  fullyParallel: true,
  // The chain specs share the anvil role accounts, and an auditor holds one
  // claim at a time, so they run one at a time.
  workers: process.env.E2E_CHAIN ? 1 : undefined,
  forbidOnly: ci,
  retries: ci ? 1 : 0,
  timeout: 30_000,
  reporter: [[ci ? "github" : "list"], ["html", { outputFolder: "playwright-report", open: "never" }]],
  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
