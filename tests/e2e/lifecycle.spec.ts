import { expect, test } from "@playwright/test";
import {
  claimAndProve,
  SKIP_REASON,
  startAsDeveloper,
  switchRole,
  uploadFundedVault,
} from "./chain-helpers";

/**
 * The whole bounty lifecycle in the browser, on the local chain:
 * the developer uploads a contract and funds its bounty once the analysis is
 * done, the auditor stakes, claims and
 * proves the reentrancy, the payout lands after the 60-second challenge
 * window, and the auditor withdraws it. Every transaction is signed in the
 * browser with the role's anvil account.
 *
 * Needs `pnpm stack:demo` (fresh chain and database) and the web app against
 * the real API, with no mocks:
 *   NEXT_PUBLIC_API_MOCKING=disabled API_INTERNAL_URL=http://localhost:3001 pnpm --filter @bbm/web dev
 *   E2E_CHAIN=1 pnpm test:e2e -- lifecycle
 * (The mixed live mode, NEXT_PUBLIC_API_MOCKING=enabled with
 * NEXT_PUBLIC_LIVE_PIPELINE and NEXT_PUBLIC_LIVE_CHAIN, works too.)
 */

test.skip(!process.env.E2E_CHAIN, SKIP_REASON);
// One auditor account plays both tests, and an auditor holds one claim at a
// time, so they run in order: payout first, which releases the claim.
test.describe.configure({ mode: "serial" });

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
  await page.getByRole("button", { name: "Withdraw", exact: true }).click();
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
