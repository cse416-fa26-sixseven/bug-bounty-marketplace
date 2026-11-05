import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  FIXTURES,
  SKIP_REASON,
  stakeAndClaim,
  startAsDeveloper,
  switchRole,
  uploadFundedVault,
} from "./chain-helpers";

/**
 * The features lifecycle.spec.ts does not reach, end to end on the local
 * chain against the real API (no mocks): developer notes, cancelling a funded
 * bounty, the auditor's false-positive mark and an auditor-reported finding
 * that is verified and paid.
 *
 * Same setup as lifecycle.spec.ts:
 *   pnpm stack:demo
 *   NEXT_PUBLIC_API_MOCKING=disabled API_INTERNAL_URL=http://localhost:3001 pnpm --filter @bbm/web dev
 *   E2E_CHAIN=1 pnpm test:e2e -- features
 */

test.skip(!process.env.E2E_CHAIN, SKIP_REASON);
// The auditor holds one claim at a time; the second test ends with its payout,
// which releases the claim for the next run.
test.describe.configure({ mode: "serial" });

test("developer notes a finding, the note persists, and the funded bounty is cancelled", async ({
  page,
}) => {
  test.setTimeout(600_000);
  page.on("dialog", (dialog) => void dialog.accept());
  await startAsDeveloper(page);
  await uploadFundedVault(page);

  const note = `Known issue, fixed in v2 (run ${Date.now()}).`;
  await page.getByRole("button", { name: "Add a note" }).first().click();
  await page.getByLabel("Your note").fill(note);
  await page.getByRole("button", { name: "Save note" }).click();
  await expect(page.getByText(note)).toBeVisible({ timeout: 30_000 });
  await page.reload();
  await expect(page.getByText(note)).toBeVisible({ timeout: 30_000 });

  // Cancelling deletes the on-chain bounty (refunding it), then closes the contract.
  await page.getByRole("button", { name: "Cancel contract" }).click();
  await expect(page.getByRole("button", { name: "Cancel contract" })).toBeHidden({
    timeout: 60_000,
  });
  await expect(page.getByText("Expired", { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });
});

test("auditor marks a false positive and reports a finding that is verified and paid", async ({
  page,
}) => {
  test.setTimeout(600_000);
  await startAsDeveloper(page);
  const bounty = await uploadFundedVault(page);
  const contractId = page.url().split("/").pop();
  await stakeAndClaim(page, bounty);

  // Slither's informational low-level-calls finding is the false positive.
  const lowLevel = page.getByRole("listitem").filter({ hasText: "low-level-calls" });
  await lowLevel.getByRole("button", { name: "Mark false positive" }).click();
  await expect(lowLevel.getByText("Marked false positive by auditor.")).toBeVisible({
    timeout: 30_000,
  });

  const title = `Vault drained through withdraw reentrancy (run ${Date.now()})`;
  await page.getByRole("button", { name: "Report a new finding" }).click();
  const form = page.getByRole("form", { name: "Report a new finding" });
  await form.getByLabel("Title").fill(title);
  await form.getByLabel("Severity").selectOption("High");
  await form
    .getByLabel("Description")
    .fill("withdraw() sends ETH before zeroing the balance, so a contract can re-enter it.");
  await form
    .getByLabel("PoC test file")
    .setInputFiles(path.join(FIXTURES, "pocs", "PoC_pass.t.sol"));
  await form.getByRole("button", { name: "Submit finding and PoC" }).click();

  const reported = page.getByRole("listitem").filter({ hasText: title });
  await expect(reported.getByText("Verified", { exact: true })).toBeVisible({ timeout: 120_000 });
  // The keeper pays once the 60-second window closes; that releases the claim.
  await expect(reported.getByText("Paid", { exact: true })).toBeVisible({ timeout: 150_000 });

  // The developer sees the auditor's finding on their contract.
  await switchRole(page, "Developer");
  await page.goto(`/contracts/${contractId}`);
  await expect(page.getByText(title)).toBeVisible({ timeout: 30_000 });
});
