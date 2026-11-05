import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  AnalysisStatusSchema,
  ContractSchema,
  FindingSchema,
  PoCSubmissionSchema,
  type Finding,
} from "@bbm/shared";
import { describe, expect, it } from "vitest";
import { env } from "../lib/env.js";
import { getJson, postForm, postJson } from "../lib/http.js";
import { contractForm, uniqueAddress, validFields } from "./support.js";

/**
 * T18: the whole analysis pipeline through the public API, in no-chain mode
 * (no wallet sign-in, no stake: the API skips the stake gate without
 * CHAIN_RPC_URL and takes auditorId from the request):
 *
 *   upload Vault.sol -> Slither + LLM -> a Flagged reentrancy-eth finding
 *   -> claim -> PoC_pass.t.sol in the sandbox -> Verified
 *   -> PoC_fail.t.sol on another finding (or a second contract) -> Rejected
 *
 * Opt-in with BBM_PIPELINE=1 (tests/README.md): it needs the analysis worker
 * with a sandbox backend (compose + docker-compose.sandbox.yml, or an AKS
 * namespace with the Kata sandbox pool, ADR 0004) and takes minutes. The
 * verdict budget covers a sandbox node scaling up from zero on AKS.
 */
const skip = !env.pipeline;
if (skip) {
  console.warn("[pipeline] skipping: set BBM_PIPELINE=1 to run the upload -> PoC verdict path");
}

/** Vault.sol and the PoCs written against it (the PoCs import ../src/Vault.sol,
 * so the upload keeps that filename). Shared with the worker's own tests and
 * scripts/demo-pipeline.sh, so there is one copy of each. */
const FIXTURES = fileURLToPath(new URL("../../workers/analysis/tests/fixtures/", import.meta.url));
const VAULT_SOURCE = readFileSync(`${FIXTURES}Vault.sol`);
const POC_PASS = readFileSync(`${FIXTURES}pocs/PoC_pass.t.sol`);
const POC_FAIL = readFileSync(`${FIXTURES}pocs/PoC_fail.t.sol`);

/** Slither warm-up (solc download, LLM call) on a cold worker. */
const FLAGGED_TIMEOUT_MS = 5 * 60_000;
/** Sandbox node scale-up from zero (3-5 min on AKS) plus the forge run. */
const VERDICT_TIMEOUT_MS = 12 * 60_000;
const POLL_MS = 5_000;
/** Slack on top of each wait for the requests around it. */
const SLACK_MS = 60_000;

const api = env.apiUrl;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function uploadVault(): Promise<string> {
  const form = contractForm(validFields(), { name: "Vault.sol", content: VAULT_SOURCE });
  const created = await postForm(`${api}/api/contracts`, form, ContractSchema);
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.id;
}

async function findings(contractId: string): Promise<Finding[]> {
  const res = await getJson(`${api}/api/contracts/${contractId}/findings`, FindingSchema.array());
  expect(res.status).toBe(200);
  return res.body;
}

/** Polls until the analysis is Done and a reentrancy-eth finding is Flagged.
 * Fails early when the analysis reports Failed. */
async function waitForFlagged(contractId: string): Promise<Finding[]> {
  const deadline = Date.now() + FLAGGED_TIMEOUT_MS;
  let last = "unknown";
  while (Date.now() < deadline) {
    const status = await getJson(
      `${api}/api/contracts/${contractId}/analysis`,
      AnalysisStatusSchema,
    );
    if (status.status === 200) {
      last = status.body.status;
      if (last === "Failed") throw new Error(`analysis failed: ${status.body.error ?? "no error"}`);
      if (last === "Done") {
        const all = await findings(contractId);
        const reentrancy = all.find((f) => f.slitherDetector === "reentrancy-eth");
        if (reentrancy?.status === "Flagged") return all;
        last = `Done, reentrancy-eth ${reentrancy ? reentrancy.status : "missing"}`;
      }
    }
    await sleep(POLL_MS);
  }
  throw new Error(
    `no Flagged reentrancy-eth finding within ${FLAGGED_TIMEOUT_MS / 60_000} min (last: ${last})`,
  );
}

async function claim(contractId: string, auditorId: string): Promise<void> {
  const res = await postJson(`${api}/api/auditor/claim`, { contractId, auditorId }, ContractSchema);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(res.body.status).toBe("Claimed");
}

async function submitPoc(findingId: string, auditorId: string, poc: Uint8Array): Promise<void> {
  const form = new FormData();
  form.append("findingId", findingId);
  form.append("auditorId", auditorId);
  form.append("file", new Blob([poc], { type: "text/plain" }), "PoC.t.sol");
  const res = await postForm(`${api}/api/auditor/poc`, form, PoCSubmissionSchema);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  expect(res.body.findingId).toBe(findingId);
  expect(["Pending", "Passed", "Failed"]).toContain(res.body.sandboxStatus);
}

/** Polls the finding until the sandbox verdict moved it to Verified or Rejected. */
async function waitForVerdict(contractId: string, findingId: string): Promise<Finding["status"]> {
  const deadline = Date.now() + VERDICT_TIMEOUT_MS;
  let last: Finding["status"] | "missing" = "missing";
  while (Date.now() < deadline) {
    const finding = (await findings(contractId)).find((f) => f.id === findingId);
    last = finding?.status ?? "missing";
    if (last === "Verified" || last === "Rejected") return last;
    await sleep(POLL_MS);
  }
  throw new Error(`finding ${findingId} still ${last} after ${VERDICT_TIMEOUT_MS / 60_000} min`);
}

describe.skipIf(skip)("pipeline: upload -> findings -> claim -> PoC verdict (T18)", () => {
  // The tests run in file order and share this state; a later test is
  // skipped (not failed again) when an earlier phase did not get there.
  const state: {
    contractId?: string;
    auditorId: string;
    reentrancyId?: string;
    others: Finding[];
  } = {
    auditorId: uniqueAddress(),
    others: [],
  };

  it(
    "uploads Vault.sol and Slither flags reentrancy-eth",
    { timeout: FLAGGED_TIMEOUT_MS + SLACK_MS },
    async () => {
      const contractId = await uploadVault();
      const all = await waitForFlagged(contractId);
      const reentrancy = all.find((f) => f.slitherDetector === "reentrancy-eth");
      expect(reentrancy?.status).toBe("Flagged");
      expect(reentrancy?.severity).toBe("High");
      expect(reentrancy?.llmExplanation.length).toBeGreaterThan(0);
      state.contractId = contractId;
      state.reentrancyId = reentrancy?.id;
      state.others = all.filter((f) => f.id !== reentrancy?.id && f.status === "Flagged");
    },
  );

  it(
    "claims the contract and a working exploit PoC is Verified by the sandbox",
    { timeout: VERDICT_TIMEOUT_MS + SLACK_MS },
    async (ctx) => {
      if (!state.contractId || !state.reentrancyId) return ctx.skip();
      await claim(state.contractId, state.auditorId);
      await submitPoc(state.reentrancyId, state.auditorId, POC_PASS);
      expect(await waitForVerdict(state.contractId, state.reentrancyId)).toBe("Verified");
      const verified = (await findings(state.contractId)).find((f) => f.id === state.reentrancyId);
      expect(verified?.statusHistory.map((h) => h.status)).toEqual([
        "Flagged",
        "Submitted",
        "Verified",
      ]);
    },
  );

  it(
    "a PoC that does not reproduce is Rejected",
    { timeout: FLAGGED_TIMEOUT_MS + VERDICT_TIMEOUT_MS + SLACK_MS },
    async (ctx) => {
      if (!state.contractId) return ctx.skip();
      // Another Flagged finding under the same claim when Slither raised
      // one; otherwise a second contract claimed by a second auditor (an
      // auditor holds one active claim at a time).
      let contractId = state.contractId;
      let auditorId = state.auditorId;
      let findingId = state.others[0]?.id;
      if (!findingId) {
        contractId = await uploadVault();
        auditorId = uniqueAddress();
        const all = await waitForFlagged(contractId);
        findingId = all.find((f) => f.slitherDetector === "reentrancy-eth")?.id;
        expect(findingId).toBeTruthy();
        await claim(contractId, auditorId);
      }
      await submitPoc(findingId as string, auditorId, POC_FAIL);
      expect(await waitForVerdict(contractId, findingId as string)).toBe("Rejected");
    },
  );
});
