import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  AnalysisStatusSchema,
  AuditorFindingReportSchema,
  AuditorProfileSchema,
  ContractSchema,
  FindingSchema,
  bountyEscrowAbi,
  type Contract,
  type Finding,
} from "@bbm/shared";
import { parseEther } from "viem";
import { beforeAll, describe, expect, it } from "vitest";
import {
  Session,
  chainAddresses,
  chainNow,
  freshAccount,
  fund,
  increaseTime,
  operatorWrite,
  onchainId,
  pollUntil,
  publicClient,
  readStaking,
  signIn,
  stake,
  write,
  type ChainAddresses,
} from "../lib/chain.js";
import { env } from "../lib/env.js";
import { SAMPLE_SOURCE } from "./support.js";

/**
 * Chain mode through the public API: wallet sign-in (SIWE), the developer's
 * on-chain funding / cancel / reclaim confirmed by the API, the auditor's
 * stake gate and on-chain claim lock, developer notes and auditor-reported
 * findings, and the event indexer. Every test signs its own transactions with
 * fresh anvil wallets and uploads its own contracts, so tests are independent
 * and rerunnable on the same stack.
 *
 * Opt-in with BBM_CHAIN=1 (tests/README.md): needs an API with CHAIN_RPC_URL
 * and SESSION_SECRET (docker-compose.ci-chain.yml, or `pnpm stack:demo`) and
 * the analysis worker, since funding and claims wait for a finished analysis.
 * PoC -> sandbox verdict -> dispute is out of scope (e2e lifecycle covers it).
 */
const skip = !env.chain;
if (skip) {
  console.warn("[chain-flows] skipping: set BBM_CHAIN=1 against a chain-mode API");
}

const api = env.chainApiUrl;
const BOUNTY = parseEther("0.01");
/** Far enough out that anvil clock jumps (the reclaim test, demo lapses) stay behind it. */
const FAR_DEADLINE = new Date("2030-01-01T00:00:00.000Z");
/** Slither warm-up on a cold worker (solc, first run). */
const ANALYSIS_TIMEOUT_MS = 5 * 60_000;
/** INDEXER_POLL_MS (5 s in stack:demo, 1 s in CI) plus confirmations and slack. */
const INDEXER_TIMEOUT_MS = 60_000;

const POC_PASS = readFileSync(
  fileURLToPath(
    new URL("../../workers/analysis/tests/fixtures/pocs/PoC_pass.t.sol", import.meta.url),
  ),
);

function uploadForm(deadline: Date): FormData {
  const form = new FormData();
  form.append("bountyAmount", BOUNTY.toString());
  form.append("currency", "ETH");
  form.append("deadline", deadline.toISOString());
  form.append("file", new Blob([SAMPLE_SOURCE], { type: "text/plain" }), "Sample.sol");
  return form;
}

async function upload(dev: Session, deadline = FAR_DEADLINE): Promise<Contract> {
  const res = await dev.json("/api/contracts", { method: "POST", body: uploadForm(deadline) });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const contract = ContractSchema.parse(res.body);
  expect(contract.developerAddress.toLowerCase()).toBe(dev.address.toLowerCase());
  return contract;
}

async function waitForAnalysis(contractId: string): Promise<void> {
  const status = await pollUntil(
    `analysis of ${contractId}`,
    async () => {
      const res = await fetch(`${api}/api/contracts/${contractId}/analysis`);
      return res.ok ? AnalysisStatusSchema.parse(await res.json()) : null;
    },
    (s) => s?.status === "Done" || s?.status === "Failed",
    { timeoutMs: ANALYSIS_TIMEOUT_MS, intervalMs: 2_000 },
  );
  expect(status?.status, JSON.stringify(status)).toBe("Done");
}

async function getContract(id: string): Promise<Contract> {
  const res = await fetch(`${api}/api/contracts/${id}`);
  expect(res.status).toBe(200);
  return ContractSchema.parse(await res.json());
}

async function findings(contractId: string): Promise<Finding[]> {
  const res = await fetch(`${api}/api/contracts/${contractId}/findings`);
  expect(res.status).toBe(200);
  return FindingSchema.array().parse(await res.json());
}

async function queueIds(): Promise<string[]> {
  const res = await fetch(`${api}/api/auditor/queue`);
  expect(res.status).toBe(200);
  // Queue items are Contracts plus their bounty terms.
  return ContractSchema.array()
    .parse(await res.json())
    .map((item) => item.id);
}

// Analysis of a cold worker alone can take minutes.
describe.skipIf(skip)(`chain mode (${api})`, { timeout: 8 * 60_000 }, () => {
  let chain: ChainAddresses;

  beforeAll(async () => {
    chain = await chainAddresses(api);
  });

  /** Upload as `dev`, wait for the analysis, fund on-chain, POST /funded. */
  async function fundedContract(dev: Session, deadline = FAR_DEADLINE): Promise<Contract> {
    const contract = await upload(dev, deadline);
    await waitForAnalysis(contract.id);
    await fund(dev.account, chain.bountyEscrow, contract.id, BOUNTY, deadline);
    const res = await dev.json(`/api/contracts/${contract.id}/funded`, { method: "POST" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return ContractSchema.parse(res.body);
  }

  async function profile(session: Session) {
    const res = await session.json("/api/auditor/profile");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return AuditorProfileSchema.parse(res.body);
  }

  function reportForm(contractId: string): FormData {
    const form = new FormData();
    form.append("contractId", contractId);
    form.append("title", "Reentrancy in withdraw");
    form.append("severity", "High");
    form.append("description", "withdraw() sends ETH before zeroing the balance.");
    form.append("file", new Blob([POC_PASS], { type: "text/plain" }), "PoC_report.t.sol");
    return form;
  }

  describe("SIWE sign-in", () => {
    it("nonce -> login -> me -> logout", async () => {
      const session = new Session(api, await freshAccount("0"));
      const issued = await session.nonce();
      expect(issued.status).toBe(200);
      const message = issued.body.message ?? "";
      expect(message).toContain(session.address);
      expect(message).toContain("Sign in to BountyGuard.");
      expect(message).toContain("Chain ID: 31337");
      expect(message).toContain(`Nonce: ${issued.body.nonce}`);

      const login = await session.login(message, await session.account.signMessage({ message }));
      expect(login.status, JSON.stringify(login.body)).toBe(200);
      expect(login.body.address).toBe(session.address);

      const me = await session.json<{ address: string }>("/api/auth/me");
      expect(me.status).toBe(200);
      expect(me.body.address).toBe(session.address);

      // A second session for the same wallet, and a copy of the first one's
      // cookie taken before it logs out.
      const other = await signIn(api, session.account);
      const copied = session.rawCookie ?? "";
      expect(copied).not.toBe("");
      const replay = (path: string) => fetch(`${api}${path}`, { headers: { cookie: copied } });
      expect((await replay("/api/auditor/profile")).status).toBe(200);

      const logout = await session.json("/api/auth/logout", { method: "POST" });
      expect(logout.status).toBe(200);
      expect(session.rawCookie).toBeNull();
      expect((await session.json("/api/auth/me")).status).toBe(401);

      // Logout ends the session server-side (M5-4): the copied cookie is
      // refused, and the wallet's other session is not affected.
      expect((await replay("/api/auth/me")).status).toBe(401);
      expect((await replay("/api/auditor/profile")).status).toBe(401);
      expect((await other.json("/api/auth/me")).status).toBe(200);
    });

    it("rejects a replayed (already used) nonce", async () => {
      const session = new Session(api, await freshAccount("0"));
      const { body } = await session.nonce();
      const message = body.message ?? "";
      const signature = await session.account.signMessage({ message });
      expect((await session.login(message, signature)).status).toBe(200);

      const replay = await new Session(api, session.account).login(message, signature);
      expect(replay.status).toBe(401);
      expect(replay.body.error).toMatch(/no open sign-in request/);
    });

    it("rejects a signature from another wallet, and keeps the nonce for the right one", async () => {
      const session = new Session(api, await freshAccount("0"));
      const { body } = await session.nonce();
      const message = body.message ?? "";
      const imposter = await freshAccount("0");
      const bad = await session.login(message, await imposter.signMessage({ message }));
      expect(bad.status).toBe(401);
      expect(bad.body.error).toMatch(/signature does not match/);

      const good = await session.login(message, await session.account.signMessage({ message }));
      expect(good.status, JSON.stringify(good.body)).toBe(200);
    });

    it("rejects a sign-in from another site's origin", async () => {
      const session = new Session(api, await freshAccount("0"));
      const { body } = await session.nonce();
      const message = body.message ?? "";
      const signature = await session.account.signMessage({ message });
      const evil = { origin: "http://evil.example" };
      const login = await session.login(message, signature, evil);
      expect(login.status).toBe(401);
      expect(login.body.error).toMatch(/another site/);
      // The failed attempt did not spend the nonce: the real origin still signs in.
      expect((await session.login(message, signature)).status).toBe(200);
    });

    it("refuses chain-mode user routes without a session", async () => {
      const anonymous = new Session(api, await freshAccount("0"));
      const upload = await anonymous.json("/api/contracts", {
        method: "POST",
        body: uploadForm(FAR_DEADLINE),
      });
      expect(upload.status).toBe(401);
      expect((await anonymous.json("/api/auditor/profile")).status).toBe(401);
      expect((await anonymous.json("/api/auth/me")).status).toBe(401);
    });

    it("refuses to act for another wallet (403)", async () => {
      const dev = await signIn(api, await freshAccount("0"));
      const form = uploadForm(FAR_DEADLINE);
      form.append("developerAddress", (await freshAccount("0")).address);
      const res = await dev.json("/api/contracts", { method: "POST", body: form });
      expect(res.status).toBe(403);
    });
  });

  describe("developer", () => {
    it("funds on-chain, then POST /funded lists the bounty for auditors", async () => {
      const dev = await signIn(api, await freshAccount());
      const contract = await upload(dev);
      await waitForAnalysis(contract.id);

      const early = await dev.json(`/api/contracts/${contract.id}/funded`, { method: "POST" });
      expect(early.status).toBe(409);
      expect(await queueIds()).not.toContain(contract.id);

      await fund(dev.account, chain.bountyEscrow, contract.id, BOUNTY, FAR_DEADLINE);
      // Only the contract's developer can confirm it.
      const other = await signIn(api, await freshAccount("0"));
      expect(
        (await other.json(`/api/contracts/${contract.id}/funded`, { method: "POST" })).status,
      ).toBe(403);

      const funded = await dev.json(`/api/contracts/${contract.id}/funded`, { method: "POST" });
      expect(funded.status, JSON.stringify(funded.body)).toBe(200);
      expect(ContractSchema.parse(funded.body).status).toBe("Open");
      expect(await queueIds()).toContain(contract.id);
      // Idempotent.
      expect(
        (await dev.json(`/api/contracts/${contract.id}/funded`, { method: "POST" })).status,
      ).toBe(200);
    });

    it("rejects /funded when the on-chain amount differs from the bounty", async () => {
      const dev = await signIn(api, await freshAccount());
      const contract = await upload(dev);
      await waitForAnalysis(contract.id);
      await fund(dev.account, chain.bountyEscrow, contract.id, BOUNTY / 2n, FAR_DEADLINE);
      const res = await dev.json(`/api/contracts/${contract.id}/funded`, { method: "POST" });
      expect(res.status).toBe(409);
      expect(await queueIds()).not.toContain(contract.id);
    });

    it("cancel: deleteBounty on-chain, then POST /cancel marks it Expired", async () => {
      const dev = await signIn(api, await freshAccount());
      const contract = await fundedContract(dev);

      const early = await dev.json(`/api/contracts/${contract.id}/cancel`, { method: "POST" });
      expect(early.status).toBe(409);
      expect(early.body).toEqual({ error: "bounty not deleted on-chain" });

      const before = await publicClient.getBalance({ address: dev.address });
      await write(dev.account, {
        address: chain.bountyEscrow,
        abi: bountyEscrowAbi,
        functionName: "deleteBounty",
        args: [onchainId(contract.id)],
      });
      // The bounty came back, less gas.
      expect(await publicClient.getBalance({ address: dev.address })).toBeGreaterThan(before);

      const cancelled = await dev.json(`/api/contracts/${contract.id}/cancel`, { method: "POST" });
      expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
      expect(ContractSchema.parse(cancelled.body).status).toBe("Expired");
      expect((await getContract(contract.id)).status).toBe("Expired");
      expect(await queueIds()).not.toContain(contract.id);
    });

    it("cancel needs no on-chain step for a contract never funded", async () => {
      const dev = await signIn(api, await freshAccount("0"));
      const contract = await upload(dev);
      const res = await dev.json(`/api/contracts/${contract.id}/cancel`, { method: "POST" });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(ContractSchema.parse(res.body).status).toBe("Expired");
    });
  });

  describe("auditor", () => {
    it("is refused a claim without stake (no lock, no claim), stakes, claims, then reports a finding", async () => {
      const dev = await signIn(api, await freshAccount());
      const contract = await fundedContract(dev);
      const auditor = await signIn(api, await freshAccount());

      const fresh = await profile(auditor);
      expect(fresh).toMatchObject({ stake: "0", activeSubmissions: 0, claimedContractIds: [] });

      // Claiming needs the required stake: refused before any lock or claim.
      const refused = await auditor.postJson("/api/auditor/claim", { contractId: contract.id });
      expect(refused.status, JSON.stringify(refused.body)).toBe(403);
      expect(refused.body).toEqual({ error: "Auditor stake is below the required stake" });
      expect(await readStaking(chain.auditorStaking, "activeSubmissions", auditor.address)).toBe(
        0n,
      );
      expect((await profile(auditor)).claimedContractIds).toEqual([]);
      expect((await getContract(contract.id)).status).toBe("Open");

      await stake(auditor.account, chain.auditorStaking, chain.requiredStakeWei);
      expect((await profile(auditor)).stake).toBe(chain.requiredStakeWei.toString());

      // Staked: the claim takes the on-chain lock.
      const claim = await auditor.postJson("/api/auditor/claim", { contractId: contract.id });
      expect(claim.status, JSON.stringify(claim.body)).toBe(200);
      expect(ContractSchema.parse(claim.body).status).toBe("Claimed");
      expect(await readStaking(chain.auditorStaking, "activeSubmissions", auditor.address)).toBe(
        1n,
      );
      const claimed = await profile(auditor);
      expect(claimed.activeSubmissions).toBe(1);
      expect(claimed.claimedContractIds).toContain(contract.id);
      expect((await getContract(contract.id)).status).toBe("Claimed");

      const reported = await auditor.json("/api/auditor/findings", {
        method: "POST",
        body: reportForm(contract.id),
      });
      expect(reported.status, JSON.stringify(reported.body)).toBe(201);
      const { finding, poc } = AuditorFindingReportSchema.parse(reported.body);
      expect(finding).toMatchObject({
        status: "Submitted",
        source: "auditor",
        contractId: contract.id,
      });
      expect(finding.reportedByAuditorId?.toLowerCase()).toBe(auditor.address.toLowerCase());
      expect(poc.auditorId.toLowerCase()).toBe(auditor.address.toLowerCase());
      expect((await findings(contract.id)).map((f) => f.id)).toContain(finding.id);
    });

    it("cannot claim a bounty that is not funded on-chain", async () => {
      const dev = await signIn(api, await freshAccount("0"));
      const contract = await upload(dev);
      await waitForAnalysis(contract.id);
      const auditor = await signIn(api, await freshAccount());
      // Staked, so the claim gets past the stake gate to the funding check.
      await stake(auditor.account, chain.auditorStaking, chain.requiredStakeWei);
      const res = await auditor.postJson("/api/auditor/claim", { contractId: contract.id });
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: "bounty not funded on-chain" });
      // Claiming for another wallet is refused before anything else.
      const forOther = await auditor.postJson("/api/auditor/claim", {
        contractId: contract.id,
        auditorId: dev.address,
      });
      expect(forOther.status).toBe(403);
    });

    it("cancelling a claimed bounty releases the auditor's on-chain lock", async () => {
      const dev = await signIn(api, await freshAccount());
      const contract = await fundedContract(dev);
      const auditor = await signIn(api, await freshAccount());
      await stake(auditor.account, chain.auditorStaking, chain.requiredStakeWei);
      expect(
        (await auditor.postJson("/api/auditor/claim", { contractId: contract.id })).status,
      ).toBe(200);
      expect(await readStaking(chain.auditorStaking, "activeSubmissions", auditor.address)).toBe(
        1n,
      );

      await write(dev.account, {
        address: chain.bountyEscrow,
        abi: bountyEscrowAbi,
        functionName: "deleteBounty",
        args: [onchainId(contract.id)],
      });
      const cancelled = await dev.json(`/api/contracts/${contract.id}/cancel`, { method: "POST" });
      expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
      expect(await readStaking(chain.auditorStaking, "activeSubmissions", auditor.address)).toBe(
        0n,
      );
      expect((await profile(auditor)).activeSubmissions).toBe(0);
    });
  });

  describe("developer notes and the indexer", () => {
    it("the developer notes an auditor-reported finding; FindingVerified on-chain is indexed", async () => {
      const dev = await signIn(api, await freshAccount());
      const contract = await fundedContract(dev);
      const auditor = await signIn(api, await freshAccount());
      await stake(auditor.account, chain.auditorStaking, chain.requiredStakeWei);
      expect(
        (await auditor.postJson("/api/auditor/claim", { contractId: contract.id })).status,
      ).toBe(200);
      const reported = await auditor.json("/api/auditor/findings", {
        method: "POST",
        body: reportForm(contract.id),
      });
      expect(reported.status, JSON.stringify(reported.body)).toBe(201);
      const { finding } = AuditorFindingReportSchema.parse(reported.body);

      // Note: only the contract's developer writes it; everyone reads it.
      const byAuditor = await auditor.json(`/api/findings/${finding.id}/note`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ note: "not mine to write" }),
      });
      expect(byAuditor.status).toBe(403);
      const noted = await dev.json(`/api/findings/${finding.id}/note`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ note: "  Known issue, fixed in v2.  " }),
      });
      expect(noted.status, JSON.stringify(noted.body)).toBe(200);
      expect(FindingSchema.parse(noted.body).developerNote).toBe("Known issue, fixed in v2.");
      const listed = (await findings(contract.id)).find((f) => f.id === finding.id);
      expect(listed?.developerNote).toBe("Known issue, fixed in v2.");

      // Indexer: emit FindingVerified as the operator would after a passing
      // PoC (the sandbox is out of scope here), then wait for the API to
      // pick the event up and move the finding Submitted -> Verified.
      const contractKey = onchainId(contract.id);
      await operatorWrite({
        address: chain.bountyEscrow,
        abi: bountyEscrowAbi,
        functionName: "recordSubmission",
        args: [contractKey],
      });
      await operatorWrite({
        address: chain.bountyEscrow,
        abi: bountyEscrowAbi,
        functionName: "recordVerification",
        args: [contractKey, onchainId(finding.id), auditor.address],
      });
      const indexed = await pollUntil(
        `finding ${finding.id} indexed as Verified`,
        async () => (await findings(contract.id)).find((f) => f.id === finding.id)?.status,
        // Paid too: with a short challenge window (stack:demo) the keeper may already have paid.
        (status) => status === "Verified" || status === "Paid",
        { timeoutMs: INDEXER_TIMEOUT_MS },
      );
      expect(["Verified", "Paid"]).toContain(indexed);
    });
  });

  // Last: it moves anvil's clock forward for good (past deadline + refund delay).
  describe("reclaim", () => {
    it("refund after the deadline and refund delay, then POST /reclaim marks it Expired", async () => {
      const dev = await signIn(api, await freshAccount());
      // The deadline must be ahead of both clocks: the API's (upload) and
      // anvil's (fund), which earlier runs may have moved forward.
      const start = Math.max(Math.floor(Date.now() / 1000), await chainNow());
      const deadline = new Date((start + 600) * 1000);
      const contract = await fundedContract(dev, deadline);

      const refundDelay = (await publicClient.readContract({
        address: chain.bountyEscrow,
        abi: bountyEscrowAbi,
        functionName: "refundDelay",
      })) as bigint;
      const refundArgs = {
        address: chain.bountyEscrow,
        abi: bountyEscrowAbi,
        functionName: "refund",
        args: [onchainId(contract.id)],
      } as const;
      await expect(write(dev.account, refundArgs)).rejects.toThrow(/RefundNotDue/);
      const early = await dev.json(`/api/contracts/${contract.id}/reclaim`, { method: "POST" });
      expect(early.status).toBe(409);
      expect(early.body).toEqual({ error: "bounty not refunded on-chain" });

      const dueAt = Math.floor(deadline.getTime() / 1000) + Number(refundDelay);
      await increaseTime(dueAt - (await chainNow()) + 1);
      await write(dev.account, refundArgs);

      const reclaimed = await dev.json(`/api/contracts/${contract.id}/reclaim`, { method: "POST" });
      expect(reclaimed.status, JSON.stringify(reclaimed.body)).toBe(200);
      expect(ContractSchema.parse(reclaimed.body).status).toBe("Expired");
      expect((await getContract(contract.id)).status).toBe("Expired");
    });
  });
});
