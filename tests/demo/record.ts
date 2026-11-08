import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page } from "@playwright/test";
import { parseEther, type Hex } from "viem";
import { Stage, log, type Persona, type SceneTools } from "./stage";
import { headlessWallet, type HeadlessWallet } from "./wallet";

/**
 * Records the bounty lifecycle as a silent demo video, against a deployment
 * whose API runs on a public chain (prod on Sepolia by default). Each role is
 * a headless wallet whose key comes from the environment; the clips skip the
 * waits (analysis, sandbox, challenge window) and are joined into one file.
 *
 *   DEMO_DEVELOPER_KEY=0x… DEMO_AUDITOR_KEY=0x… pnpm --filter @bbm/system-tests demo
 *
 * Environment:
 *   BBM_WEB_URL         the web app (default: prod)
 *   DEMO_DEVELOPER_KEY  funded Sepolia key: the bounty plus gas
 *   DEMO_AUDITOR_KEY    funded Sepolia key: the 0.1 ETH stake (once) plus gas
 *   DEMO_ARBITER_KEY    the deployment's arbiter key; only for DEMO_DISPUTE=1
 *   DEMO_DISPUTE=1      also record a second bounty that the developer
 *                       disputes and the arbiter rules against the auditor
 *   DEMO_BOUNTY_ETH     base bounty amount (default 0.001; a unique suffix is added)
 *   DEMO_OUT            output directory (default tests/demo/out)
 *   DEMO_DRY=1          connect, sign in and stop: checks the wallet, the
 *                       captions and the video without spending anything
 *   DEMO_SLOWMO         ms added to every action (default 120)
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, "../../workers/analysis/tests/fixtures");
const DEFAULT_URL = "https://prod.bug-bounty.cse416-group.pranavjothivel.com";

interface ChainInfo {
  configured: boolean;
  chainId: number;
  rpcUrl?: string;
  challengeWindowSeconds: number;
  requiredStakeWei: string;
}

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function requireKey(name: string): Hex {
  const value = env(name);
  if (!value || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(
      `${name} must be a 0x-prefixed 32-byte private key (set it in the environment, never in git).`,
    );
  }
  return value as Hex;
}

async function main(): Promise<void> {
  const baseURL = (env("BBM_WEB_URL") ?? DEFAULT_URL).replace(/\/+$/, "");
  const outDir = path.resolve(env("DEMO_OUT") ?? path.join(HERE, "out"));
  const dry = env("DEMO_DRY") === "1";
  const dispute = env("DEMO_DISPUTE") === "1";
  mkdirSync(outDir, { recursive: true });

  const chain = (await (await fetch(`${baseURL}/api/chain`)).json()) as ChainInfo;
  if (!chain.configured || chain.chainId === 31337 || !chain.rpcUrl) {
    throw new Error(
      `${baseURL} is not running on a public chain with a browser RPC; this recorder needs injected-wallet mode.`,
    );
  }
  log(
    `target ${baseURL} (chain ${chain.chainId}, challenge window ${chain.challengeWindowSeconds}s)`,
  );

  const wallets = {
    developer: headlessWallet({
      key: requireKey("DEMO_DEVELOPER_KEY"),
      chainId: chain.chainId,
      rpcUrl: chain.rpcUrl,
    }),
    auditor: headlessWallet({
      key: requireKey("DEMO_AUDITOR_KEY"),
      chainId: chain.chainId,
      rpcUrl: chain.rpcUrl,
    }),
    arbiter: dispute
      ? headlessWallet({
          key: requireKey("DEMO_ARBITER_KEY"),
          chainId: chain.chainId,
          rpcUrl: chain.rpcUrl,
        })
      : null,
  };
  const bountyBase = env("DEMO_BOUNTY_ETH") ?? "0.001";
  await preflight(wallets, bountyBase, chain, dry);

  const stage = await Stage.launch({
    baseURL,
    outDir,
    slowMo: Number(env("DEMO_SLOWMO") ?? 120),
    width: 1920,
    height: 1080,
  });

  let failure: unknown;
  try {
    const developer = await stage.persona("developer", wallets.developer);
    const auditor = await stage.persona("auditor", wallets.auditor);

    await developer.scene("overview and connect", async (page, t) => {
      await page.goto("/");
      await t.hold(600);
      await t.caption("BountyGuard: AI-assisted smart contract bounties, live on Sepolia");
      await t.hold(3500);
      await connect(page, t, "The developer connects a wallet and signs in with Ethereum");
      await t.hold(1800);
      if (dry) {
        await page.goto("/submit");
        await t.caption("Dry run: wallet, captions and recording all work");
        await t.hold(2500);
      }
    });
    if (dry) return;

    const first = await fundedBounty(developer, bountyBase);
    await claimAndProve(auditor, first);
    await auditor.offCamera("wait for the challenge window and the payout", async (page) => {
      await page.goto(first.auditorUrl);
      await expect(page.getByText("Paid", { exact: true }).first()).toBeVisible({
        timeout: (chain.challengeWindowSeconds + 420) * 1000,
      });
    });
    await auditor.scene("payout and withdrawal", async (page, t) => {
      await page.goto(first.auditorUrl);
      await t.caption("Challenge window closed: the keeper pays the bounty on-chain");
      await t.hold(3500);
      await page.goto("/auditor");
      await expect(page.getByText("Payout to withdraw")).toBeVisible({ timeout: 30_000 });
      await t.caption("The auditor withdraws the payout");
      await t.click(page.getByRole("button", { name: "Withdraw", exact: true }));
      await expect(page.getByText("0 ETH", { exact: true })).toBeVisible({ timeout: 120_000 });
      await t.hold(3000);
    });

    if (dispute && wallets.arbiter) {
      const arbiter = await stage.persona("arbiter", wallets.arbiter);
      const second = await fundedBounty(developer, bountyBase);
      await claimAndProve(auditor, second);
      const reason = `The PoC does not show a realistic attack (demo ${Date.now()}).`;
      await developer.scene("dispute", async (page, t) => {
        await page.goto(second.contractUrl);
        await t.caption("The developer disagrees and disputes the finding within the window");
        await t.hold(1500);
        await t.click(page.getByRole("button", { name: /dispute this finding/i }).first());
        await t.type(page.getByLabel(/reason for dispute/i), reason);
        await t.click(page.getByRole("button", { name: /submit dispute/i }));
        await expect(page.getByText("Disputed", { exact: true }).first()).toBeVisible({
          timeout: 120_000,
        });
        await t.caption("Disputed: the payout is frozen until the arbiter rules");
        await t.hold(3000);
      });
      await arbiter.scene("ruling", async (page, t) => {
        await page.goto("/arbiter");
        await connect(page, t, "The arbiter connects and reviews the evidence");
        await t.hold(1500);
        const ruled = page.waitForResponse(
          (r) =>
            /\/api\/arbiter\/disputes\/[^/]+\/rule$/.test(r.url()) &&
            r.request().method() === "POST",
          { timeout: 120_000 },
        );
        await t.caption("The arbiter rules against the auditor");
        await t.click(
          page
            .locator("div.rounded-lg")
            .filter({ hasText: reason })
            .getByRole("button", { name: "Rule against auditor" }),
        );
        if (!(await ruled).ok()) throw new Error("the ruling was not recorded");
        await t.hold(3000);
      });
      await developer.scene("rejected", async (page, t) => {
        await page.goto(second.contractUrl);
        await expect(page.getByText("Rejected", { exact: true }).first()).toBeVisible({
          timeout: 120_000,
        });
        await t.caption(
          "Rejected: the bounty stays with the developer and half the auditor's stake is slashed",
        );
        await t.hold(4000);
      });
    }
  } catch (err) {
    log("recording failed; keeping the clips shot so far");
    failure = err;
  } finally {
    const out = await stage.finish();
    log(`video: ${out}`);
  }
  if (failure) throw failure;
}

interface Bounty {
  /** As the auditor queue shows it, e.g. "0.0012341 ETH". */
  label: string;
  contractUrl: string;
  auditorUrl: string;
}

/** Connects the wallet (SIWE sign-in) under `text`. */
async function connect(page: Page, t: SceneTools, text: string): Promise<void> {
  await t.caption(text);
  await t.click(page.getByRole("button", { name: "Connect wallet" }));
  await expect(page.getByText(/Connected as/)).toBeVisible({ timeout: 30_000 });
}

/** Developer: submits Vault.sol, waits for the analysis off camera, funds the bounty. */
async function fundedBounty(developer: Persona, bountyBase: string): Promise<Bounty> {
  // A unique amount tells this run's queue row apart; the trailing 1 keeps
  // the display from trimming it.
  const amount = `${bountyBase}${String(Date.now() % 1000).padStart(3, "0")}1`;
  let contractUrl = "";

  await developer.scene("submit a contract", async (page, t) => {
    await page.goto("/submit");
    await t.caption("The developer uploads a contract and offers a bounty");
    await page.getByLabel(/Contract source/).setInputFiles(path.join(FIXTURES, "Vault.sol"));
    await t.hold(800);
    await t.type(page.getByLabel("Bounty amount"), amount);
    await page.getByLabel("Deadline").fill("2030-01-01T00:00");
    await t.hold(600);
    await t.click(page.getByRole("button", { name: "Submit contract" }));
    await expect(page).toHaveURL(/\/contracts\/contract_/, { timeout: 60_000 });
    contractUrl = page.url();
    await t.caption("Slither and an LLM analyse the contract in the background");
    await t.hold(4000);
  });

  await developer.offCamera("wait for the analysis", async (page) => {
    await page.goto(contractUrl);
    await expect(page.getByText("reentrancy-eth").first()).toBeVisible({ timeout: 300_000 });
    await expect(page.getByRole("button", { name: "Fund bounty" })).toBeEnabled({
      timeout: 60_000,
    });
  });

  await developer.scene("review findings and fund", async (page, t) => {
    await page.goto(contractUrl);
    await t.caption("Findings are flagged, each with an AI explanation");
    const finding = page.getByText("reentrancy-eth").first();
    await finding.scrollIntoViewIfNeeded();
    await t.hold(3500);
    const fund = page.getByRole("button", { name: "Fund bounty" });
    await fund.scrollIntoViewIfNeeded();
    await t.caption("The developer locks the bounty in escrow on Sepolia");
    await t.click(fund);
    await expect(page.getByText(/Bounty funded on-chain/)).toBeVisible({ timeout: 180_000 });
    await t.hold(3000);
  });

  const id = contractUrl.slice(contractUrl.lastIndexOf("/") + 1);
  return { label: `${amount} ETH`, contractUrl, auditorUrl: `/auditor/contracts/${id}` };
}

/** Auditor: connects, stakes if needed, claims the bounty, submits the PoC, waits for Verified. */
async function claimAndProve(auditor: Persona, bounty: Bounty): Promise<void> {
  await auditor.scene("stake, claim and submit a PoC", async (page, t) => {
    await page.goto("/auditor");
    if (await page.getByRole("button", { name: "Connect wallet" }).isVisible()) {
      await connect(page, t, "An auditor connects with their own wallet");
      await t.hold(1200);
    }
    await expect(page.getByText(/PoC upload (locked|unlocked)/)).toBeVisible({ timeout: 30_000 });
    if (await page.getByText("PoC upload locked").isVisible()) {
      await t.caption("Auditors stake ETH before they can submit exploits");
      await t.click(page.getByRole("button", { name: "Post stake" }));
      await expect(page.getByText("PoC upload unlocked")).toBeVisible({ timeout: 180_000 });
      await t.hold(1500);
    }
    await t.caption("The auditor claims the bounty");
    await t.click(
      page
        .getByRole("listitem")
        .filter({ hasText: bounty.label })
        .getByRole("button", { name: "Claim" }),
    );
    await expect(page).toHaveURL(/\/auditor\/contracts\/contract_/, { timeout: 180_000 });
    await t.hold(1500);
    const card = page.getByRole("listitem").filter({ hasText: "reentrancy-eth" });
    await card.scrollIntoViewIfNeeded();
    await t.caption("…and uploads a Foundry proof-of-concept exploit");
    await card
      .getByLabel("PoC test file")
      .setInputFiles(path.join(FIXTURES, "pocs", "PoC_pass.t.sol"));
    await t.hold(800);
    await t.click(card.getByRole("button", { name: "Submit PoC" }));
    await t.caption("The PoC runs against the contract in an isolated sandbox");
    await t.hold(4000);
  });

  await auditor.offCamera("wait for the sandbox verdict", async (page) => {
    await page.goto(bounty.auditorUrl);
    await expect(page.getByText("Verified", { exact: true }).first()).toBeVisible({
      timeout: 300_000,
    });
  });

  await auditor.scene("verified", async (page, t) => {
    await page.goto(bounty.auditorUrl);
    await page.getByText("Verified", { exact: true }).first().scrollIntoViewIfNeeded();
    await t.caption("Verified: the exploit works. A challenge window opens for the developer");
    await t.hold(5000);
  });
}

/** Prints balances and refuses to start a run the accounts cannot pay for. */
async function preflight(
  wallets: { developer: HeadlessWallet; auditor: HeadlessWallet; arbiter: HeadlessWallet | null },
  bountyBase: string,
  chain: ChainInfo,
  dry: boolean,
): Promise<void> {
  const gas = parseEther("0.003");
  const need = {
    developer: parseEther(bountyBase) + parseEther("0.001") + gas,
    auditor: BigInt(chain.requiredStakeWei) + gas,
    arbiter: gas,
  };
  for (const [role, wallet] of Object.entries(wallets)) {
    if (!wallet) continue;
    const balance = await wallet.balanceEth();
    log(`${role.padEnd(9)} ${wallet.address}  ${balance} ETH`);
    if (dry) continue;
    const minimum = need[role as keyof typeof need];
    if (parseEther(balance) < minimum) {
      const hint = role === "auditor" ? " (less if this account has already staked)" : "";
      throw new Error(
        `${role} needs about ${Number(minimum) / 1e18} ETH${hint}; fund it from a Sepolia faucet.`,
      );
    }
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
