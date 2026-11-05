import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

/**
 * The whole bounty lifecycle in the browser, on the local chain:
 * the developer uploads a contract and funds its bounty once the analysis is
 * done, the auditor stakes, claims and
 * proves the reentrancy, the payout lands after the 60-second challenge
 * window, and the auditor withdraws it. Every transaction is signed in the
 * browser with the role's anvil account.
 *
 * Needs `pnpm stack:demo` (fresh chain and database) and the web app in live
 * chain mode:
 *   NEXT_PUBLIC_API_MOCKING=enabled NEXT_PUBLIC_LIVE_PIPELINE=enabled \
 *   NEXT_PUBLIC_LIVE_CHAIN=enabled API_INTERNAL_URL=http://localhost:3001 pnpm --filter @bbm/web dev
 *   E2E_CHAIN=1 pnpm test:e2e -- lifecycle
 */
const FIXTURES = fileURLToPath(new URL("../../workers/analysis/tests/fixtures", import.meta.url));

test.skip(!process.env.E2E_CHAIN, "needs pnpm stack:demo and the web app in live chain mode");
// One auditor account plays both tests, and an auditor holds one claim at a
// time, so they run in order: payout first, which releases the claim.
test.describe.configure({ mode: "serial" });

/**
 * Developer: upload Vault.sol with a bounty of a unique amount (the PoC
 * imports the target as ../src/Vault.sol, so the file keeps its name; the
 * amount tells this test's queue row apart), wait for its reentrancy finding,
 * then fund the bounty from the contract page. Returns the amount as the
 * queue shows it.
 */
async function uploadFundedVault(page: Page): Promise<string> {
  const amount = `1.${String(Date.now() % 100_000).padStart(5, "0")}1`;
  await page.goto("/submit");
  await page.getByLabel(/Contract source/).setInputFiles({
    name: "Vault.sol",
    mimeType: "text/plain",
    buffer: readFileSync(path.join(FIXTURES, "Vault.sol")),
  });
  await page.getByLabel("Bounty amount").fill(amount);
  await page.getByLabel("Deadline").fill("2030-01-01T00:00");
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

/** Auditor: stake if needed, claim the bounty shown as `amountLabel`, submit the passing PoC, wait for Verified. */
async function claimAndProve(page: Page, amountLabel: string): Promise<void> {
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
  // Each finding is a list item; submit on the reentrancy-eth one.
  const card = page.getByRole("listitem").filter({ hasText: "reentrancy-eth" });
  await card
    .getByLabel("PoC test file")
    .setInputFiles(path.join(FIXTURES, "pocs", "PoC_pass.t.sol"));
  await card.getByRole("button", { name: "Submit PoC" }).click();
  await expect(page.getByText("Verified", { exact: true }).first()).toBeVisible({
    timeout: 120_000,
  });
}

async function startAsDeveloper(page: Page): Promise<void> {
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

async function switchRole(page: Page, label: "Developer" | "Auditor" | "Arbiter") {
  const signedIn = page.waitForResponse((r) => r.url().includes("/api/auth/login") && r.ok());
  await page.getByRole("button", { name: label, exact: true }).click();
  await signedIn;
}

test("developer funds, auditor proves the exploit, the payout lands and is withdrawn", async ({
  page,
}) => {
  test.setTimeout(600_000);
  await startAsDeveloper(page);
  const bounty = await uploadFundedVault(page);
  await claimAndProve(page, bounty);

  // The keeper pays once the 60-second window closes.
  await expect(page.getByText("Paid", { exact: true }).first()).toBeVisible({ timeout: 150_000 });

  await page.goto("/auditor");
  await expect(page.getByText("Payout to withdraw")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Withdraw" }).click();
  await expect(page.getByText("0 ETH", { exact: true })).toBeVisible({ timeout: 30_000 });
});

test("developer disputes within the window and the arbiter rules against the auditor", async ({
  page,
}) => {
  test.setTimeout(600_000);
  page.on("dialog", (dialog) => void dialog.accept());
  await startAsDeveloper(page);
  const bounty = await uploadFundedVault(page);
  const contractUrl = page.url();
  await claimAndProve(page, bounty);

  // Developer: dispute while the 60-second window is open.
  await switchRole(page, "Developer");
  await page.goto(contractUrl);
  await page
    .getByRole("button", { name: /dispute this finding/i })
    .first()
    .click();
  // A reason unique to this run identifies its dispute on the arbiter page.
  const reason = `The PoC does not show a realistic attack (run ${Date.now()}).`;
  await page.getByLabel(/reason for dispute/i).fill(reason);
  await page.getByRole("button", { name: /submit dispute/i }).click();
  await expect(page.getByText("Disputed", { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });

  // Arbiter: rule against the auditor.
  await switchRole(page, "Arbiter");
  await expect(page).toHaveURL(/\/arbiter$/);
  // Wait until the API has recorded the ruling (after the on-chain rule) before
  // switching roles, so the ruling is signed and recorded as the arbiter.
  const ruled = page.waitForResponse(
    (r) =>
      /\/api\/arbiter\/disputes\/[^/]+\/rule$/.test(r.url()) && r.request().method() === "POST",
    { timeout: 60_000 },
  );
  await page
    .locator("div.rounded-lg")
    .filter({ hasText: reason })
    .getByRole("button", { name: "Rule against auditor" })
    .click();
  expect((await ruled).ok()).toBe(true);

  await switchRole(page, "Developer");
  await page.goto(contractUrl);
  await expect(page.getByText("Rejected", { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });
});
