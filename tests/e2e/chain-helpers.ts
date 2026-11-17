import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Shared steps for the browser specs that run on the local chain
 * (`pnpm stack:demo` plus the web app talking to the real API). Each role
 * signs its transactions in the browser with its anvil account.
 */
export const FIXTURES = fileURLToPath(
  new URL("../../workers/analysis/tests/fixtures", import.meta.url),
);

export const SKIP_REASON = "needs pnpm stack:demo and the web app against the real API";

/** Opens the app and makes sure the developer is the signed-in role. */
export async function startAsDeveloper(page: Page): Promise<void> {
  const firstSignIn = page.waitForResponse((r) => r.url().includes("/api/auth/login") && r.ok());
  await page.goto("/submit");
  await firstSignIn;
  if (
    (await page
      .getByRole("button", { name: "Developer", exact: true })
      .getAttribute("aria-pressed")) !== "true"
  ) {
    await switchRole(page, "Developer");
  }
  await expect(page.getByText("Local test chain")).toBeVisible();
}

/** Switches the header role and waits for that role's sign-in. */
export async function switchRole(
  page: Page,
  label: "Developer" | "Auditor" | "Arbiter",
): Promise<void> {
  const signedIn = page.waitForResponse((r) => r.url().includes("/api/auth/login") && r.ok());
  await page.getByRole("button", { name: label, exact: true }).click();
  await signedIn;
}

/**
 * Developer: upload Vault.sol with a bounty of a unique amount (the PoC
 * imports the target as ../src/Vault.sol, so the file keeps its name; the
 * amount tells this run's queue row apart), wait for its reentrancy finding,
 * then fund the bounty from the contract page. Returns the amount as the
 * queue shows it.
 */
export async function uploadFundedVault(
  page: Page,
  options: { deadline?: Date } = {},
): Promise<string> {
  const amount = `1.${String(Date.now() % 100_000).padStart(5, "0")}1`;
  await page.goto("/submit");
  await page.getByLabel(/Contract source/).setInputFiles({
    name: "Vault.sol",
    mimeType: "text/plain",
    buffer: readFileSync(path.join(FIXTURES, "Vault.sol")),
  });
  await page.getByLabel("Bounty amount").fill(amount);
  await page
    .getByLabel("Deadline")
    .fill(options.deadline ? toLocalInput(options.deadline) : "2030-01-01T00:00");
  await page.getByRole("button", { name: "Submit contract" }).click();
  await expect(page).toHaveURL(/\/contracts\/contract_/, { timeout: 60_000 });
  // Slither plus LLM explanations: usually under a minute, up to ~3 with a slow LLM.
  await expect(page.getByText("reentrancy-eth").first()).toBeVisible({ timeout: 300_000 });
  // Funding waits for the analysis: the button enables once it is Done.
  const fund = page.getByRole("button", { name: "Fund bounty" });
  await expect(fund).toBeEnabled({ timeout: 60_000 });
  await fund.click();
  await expect(page.getByText(/Bounty funded on-chain/)).toBeVisible({ timeout: 60_000 });
  return `${amount} ETH`;
}

/** Auditor: stake if needed, then claim the bounty shown as `amountLabel`. */
export async function stakeAndClaim(page: Page, amountLabel: string): Promise<void> {
  await switchRole(page, "Auditor");
  await expect(page).toHaveURL(/\/auditor$/);
  // Wait for the profile to load, then stake only if the gate is locked.
  await expect(page.getByText(/PoC upload (locked|unlocked)/)).toBeVisible({ timeout: 30_000 });
  if (await page.getByText("PoC upload locked").isVisible()) {
    await page.getByRole("button", { name: "Post stake" }).click();
  }
  await expect(page.getByText("PoC upload unlocked")).toBeVisible({ timeout: 30_000 });
  await page
    .getByRole("listitem")
    .filter({ hasText: amountLabel })
    .getByRole("button", { name: "Claim" })
    .click();
  await expect(page).toHaveURL(/\/auditor\/contracts\/contract_/, { timeout: 30_000 });
}

/** Auditor, on the claimed contract's page: submits a PoC fixture
 * (`PoC_pass.t.sol`, `PoC_fail.t.sol`) on the reentrancy-eth finding. */
export async function submitPoc(page: Page, fixture: string): Promise<void> {
  // Each finding is a list item; submit on the reentrancy-eth one.
  const card = page.getByRole("listitem").filter({ hasText: "reentrancy-eth" });
  await card.getByLabel("PoC test file").setInputFiles(path.join(FIXTURES, "pocs", fixture));
  await card.getByRole("button", { name: "Submit PoC" }).click();
}

/** Auditor: stake, claim, submit the passing PoC on reentrancy-eth, wait for Verified. */
export async function claimAndProve(page: Page, amountLabel: string): Promise<void> {
  await stakeAndClaim(page, amountLabel);
  await submitPoc(page, "PoC_pass.t.sol");
  await expect(page.getByText("Verified", { exact: true }).first()).toBeVisible({
    timeout: 120_000,
  });
}

/** The value under a label in the auditor's profile summary on /auditor
 * ("Stake", "Reputation", "Payout to withdraw"). */
export function profileValue(page: Page, label: string): Locator {
  return page.getByText(label, { exact: true }).locator("xpath=following-sibling::p[1]");
}

/** `datetime-local` value for a date, in local time (the browser's and this
 * process's: Playwright runs the browser in the host's time zone). */
export function toLocalInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

const RPC_URL = (process.env.BBM_RPC_URL ?? "http://localhost:8545").replace(/\/+$/, "");

/** One JSON-RPC call to the local anvil node. */
export async function rpc<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result as T;
}

/** The latest block's timestamp in seconds. It runs ahead of the wall clock
 * once a spec has moved the chain forward. */
export async function chainTime(): Promise<number> {
  const block = await rpc<{ timestamp: string }>("eth_getBlockByNumber", ["latest", false]);
  return Number(BigInt(block.timestamp));
}

/**
 * Moves anvil's clock forward and mines a block, so the next transaction sees
 * the later time. Only the chain moves: the API's challenge windows and claim
 * expiries run on the wall clock, and a chain ahead of it only lets on-chain
 * time checks (payout, refund) pass sooner, so later specs are unaffected.
 */
export async function advanceChainTime(seconds: number): Promise<void> {
  await rpc("evm_increaseTime", [Math.ceil(seconds)]);
  await rpc("evm_mine");
}
