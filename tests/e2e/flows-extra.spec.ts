import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  advanceChainTime,
  chainTime,
  claimAndProve,
  FIXTURES,
  profileValue,
  rpc,
  SKIP_REASON,
  stakeAndClaim,
  startAsDeveloper,
  submitPoc,
  switchRole,
  uploadFundedVault,
} from "./chain-helpers";

/**
 * The on-chain paths lifecycle.spec.ts and features.spec.ts do not reach, in
 * the browser against the real API (no mocks): the arbiter ruling for the
 * auditor, withdrawing stake once its lock is released, a failing PoC that
 * ends Rejected, and the developer reclaiming an expired bounty.
 *
 * Each test uploads and funds its own contract and leaves the auditor without
 * a claim, so the tests do not depend on each other's state. The reclaim test
 * moves anvil's clock forward, so it runs last.
 *
 * Same setup as lifecycle.spec.ts:
 *   pnpm stack:demo
 *   NEXT_PUBLIC_API_MOCKING=disabled API_INTERNAL_URL=http://localhost:3001 pnpm --filter @bbm/web dev
 *   E2E_CHAIN=1 pnpm test:e2e -- flows-extra
 */

test.skip(!process.env.E2E_CHAIN, SKIP_REASON);
test.describe.configure({ mode: "serial" });

/** anvil account #1, the developer role's wallet (lib/chain/accounts.ts). */
const DEVELOPER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
/** deploy script's REFUND_DELAY on the demo stack. */
const REFUND_DELAY_SECONDS = 60;

/** Developer: disputes the first verified finding on their contract page. Returns the reason. */
async function dispute(page: Page, contractUrl: string): Promise<string> {
  await switchRole(page, "Developer");
  await page.goto(contractUrl);
  await page
    .getByRole("button", { name: /dispute this finding/i })
    .first()
    .click();
  // A reason unique to this run identifies its dispute on the arbiter page.
  const reason = `The PoC needs an unrealistic setup (run ${Date.now()}).`;
  await page.getByLabel(/reason for dispute/i).fill(reason);
  await page.getByRole("button", { name: /submit dispute/i }).click();
  await expect(page.getByText("Disputed", { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });
  return reason;
}

test("arbiter rules for the auditor: payout lands, reputation rises, stake is not slashed", async ({
  page,
}) => {
  test.setTimeout(720_000);
  page.on("dialog", (dialog) => void dialog.accept());
  await startAsDeveloper(page);
  const bounty = await uploadFundedVault(page);
  const contractUrl = page.url();
  const contractId = contractUrl.split("/").pop();
  await claimAndProve(page, bounty);

  // The 60-second challenge window is running: read the auditor's standing
  // quickly, then dispute.
  await page.goto("/auditor");
  const stake = profileValue(page, "Stake");
  const reputation = profileValue(page, "Reputation");
  await expect(reputation).toHaveText(/^-?\d+$/, { timeout: 30_000 });
  const stakeBefore = (await stake.textContent())!;
  const reputationBefore = Number(await reputation.textContent());

  const reason = await dispute(page, contractUrl);

  // Arbiter: rule for the auditor. Wait until the API has recorded it before
  // switching roles, so the ruling is signed and recorded as the arbiter.
  await switchRole(page, "Arbiter");
  await expect(page).toHaveURL(/\/arbiter$/);
  const ruled = page.waitForResponse(
    (r) =>
      /\/api\/arbiter\/disputes\/[^/]+\/rule$/.test(r.url()) && r.request().method() === "POST",
    { timeout: 60_000 },
  );
  await page
    .locator("div.rounded-lg")
    .filter({ hasText: reason })
    .getByRole("button", { name: "Rule for auditor" })
    .click();
  expect((await ruled).ok()).toBe(true);

  // The finding is Verified again and a fresh 60-second window runs; then the
  // keeper pays it.
  await switchRole(page, "Auditor");
  await page.goto(`/auditor/contracts/${contractId}`);
  const card = page.getByRole("listitem").filter({ hasText: "reentrancy-eth" });
  await expect(card.getByText("Paid", { exact: true })).toBeVisible({ timeout: 180_000 });

  await page.goto("/auditor");
  await expect(reputation).toHaveText(String(reputationBefore + 1), { timeout: 30_000 });
  await expect(stake).toHaveText(stakeBefore);
  await expect(profileValue(page, "Payout to withdraw")).not.toHaveText("0 ETH", {
    timeout: 30_000,
  });
  await page.getByRole("button", { name: "Withdraw", exact: true }).click();
  await expect(profileValue(page, "Payout to withdraw")).toHaveText("0 ETH", { timeout: 30_000 });
});

test("auditor's stake is locked while a claim is open and withdrawn once the payout releases it", async ({
  page,
}) => {
  test.setTimeout(720_000);
  await startAsDeveloper(page);
  const bounty = await uploadFundedVault(page);
  await stakeAndClaim(page, bounty);
  const claimUrl = page.url();

  // The claim locks the stake: the withdraw form is disabled and says why.
  await page.goto("/auditor");
  const withdrawStake = page.getByRole("button", { name: "Withdraw stake" });
  await expect(page.getByText(/Locked while you have an active claim/)).toBeVisible({
    timeout: 30_000,
  });
  await expect(withdrawStake).toBeDisabled();

  // Prove the exploit; the payout ends the claim and releases the lock.
  await page.goto(claimUrl);
  await submitPoc(page, "PoC_pass.t.sol");
  const card = page.getByRole("listitem").filter({ hasText: "reentrancy-eth" });
  await expect(card.getByText("Verified", { exact: true })).toBeVisible({ timeout: 120_000 });
  await expect(card.getByText("Paid", { exact: true })).toBeVisible({ timeout: 150_000 });

  await page.goto("/auditor");
  await expect(page.getByText(/Locked while you have an active claim/)).toBeHidden({
    timeout: 60_000,
  });
  await expect(withdrawStake).toBeEnabled();
  // The amount defaults to the whole stake.
  await withdrawStake.click();
  await expect(profileValue(page, "Stake")).toHaveText("0", { timeout: 30_000 });
  await expect(page.getByText("PoC upload locked")).toBeVisible();

  // Leave nothing behind: withdraw the payout too.
  await page.getByRole("button", { name: "Withdraw", exact: true }).click();
  await expect(profileValue(page, "Payout to withdraw")).toHaveText("0 ETH", { timeout: 30_000 });
});

test("a failing PoC ends Rejected for the auditor and the developer", async ({ page }) => {
  test.setTimeout(720_000);
  await startAsDeveloper(page);
  const bounty = await uploadFundedVault(page);
  const contractUrl = page.url();
  await stakeAndClaim(page, bounty);

  await submitPoc(page, "PoC_fail.t.sol");
  const card = page.getByRole("listitem").filter({ hasText: "reentrancy-eth" });
  await expect(card.getByText("Rejected", { exact: true })).toBeVisible({ timeout: 120_000 });

  await switchRole(page, "Developer");
  await page.goto(contractUrl);
  // reentrancy-eth is the only finding with a PoC, so the only Rejected one.
  await expect(page.getByText("Rejected", { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });

  // A failed verdict keeps the claim (the auditor may try again until it
  // expires, 10 minutes on the demo stack), which would block the next
  // spec's claim. Close it the way an auditor would: report the exploit with
  // a passing PoC, which is verified and paid, and the payout ends the claim.
  await switchRole(page, "Auditor");
  await page.goto(contractUrl.replace("/contracts/", "/auditor/contracts/"));
  const title = `Reentrancy in withdraw, second attempt (run ${Date.now()})`;
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
  await expect(reported.getByText("Paid", { exact: true })).toBeVisible({ timeout: 270_000 });
});

test("developer reclaims the bounty after the deadline and refund delay", async ({ page }) => {
  test.setTimeout(720_000);
  page.on("dialog", (dialog) => void dialog.accept());
  // A deadline 10 minutes out (on the later of the wall and chain clocks)
  // leaves time for the analysis before funding; the chain then jumps past
  // it instead of the test waiting.
  const nowSeconds = Math.max(Math.floor(Date.now() / 1000), await chainTime());
  const deadline = new Date((Math.ceil(nowSeconds / 60) * 60 + 600) * 1000);

  await startAsDeveloper(page);
  const bounty = await uploadFundedVault(page, { deadline });
  const amountWei = BigInt(Math.round(Number.parseFloat(bounty) * 1e5)) * 10n ** 13n;

  // Before the deadline the button is shown but disabled.
  const reclaim = page.getByRole("button", { name: "Reclaim bounty" });
  await expect(reclaim).toBeDisabled({ timeout: 30_000 });

  // Move the chain past deadline + refund delay (BountyEscrow.refund checks
  // block.timestamp) and the browser clock past the deadline (the page enables
  // the button from Date.now()). The API's clock is not involved.
  const dueAt = deadline.getTime() / 1000 + REFUND_DELAY_SECONDS;
  await advanceChainTime(dueAt + 5 - (await chainTime()));
  await page.clock.install({ time: new Date((dueAt + 30) * 1000) });
  await page.reload();

  const before = BigInt(await rpc<string>("eth_getBalance", [DEVELOPER, "latest"]));
  await expect(reclaim).toBeEnabled({ timeout: 30_000 });
  await reclaim.click();
  await expect(page.getByText("Expired", { exact: true }).first()).toBeVisible({
    timeout: 60_000,
  });
  await expect(reclaim).toBeHidden();
  // The bounty came back to the developer's wallet (less gas).
  const after = BigInt(await rpc<string>("eth_getBalance", [DEVELOPER, "latest"]));
  expect(after - before).toBeGreaterThan((amountWei * 99n) / 100n);
});
