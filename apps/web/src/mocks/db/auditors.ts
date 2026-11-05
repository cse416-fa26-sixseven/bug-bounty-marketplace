import {
  AUDITOR_FINDING_DETECTOR,
  AuditorFindingFieldsSchema,
  PocSourceFilenameSchema,
  PocSourceSizeSchema,
  compareWei,
  PositiveWeiSchema,
  type AuditorFindingReport,
  type AuditorProfile,
  type Contract,
  type Finding,
  type PoCSubmission,
  type Wei,
} from "@bbm/shared";
import { ethToWei } from "../../lib/money";
import { MOCK_ADDRESSES } from "../../lib/addresses";
import { db } from "./store";
import { nextId } from "./ids";
import { scheduleOnce } from "./scheduler";
import { SANDBOX_DELAY_MS, CLAIM_WINDOW_MS } from "./timing";
import { MockApiError } from "./errors";
import { armChallengeWindow, findContractById, findFindingById } from "./contracts";

/** Fixed id of the single seeded auditor profile. Exported so db/contracts.ts
 * can pre-assign claims to this auditor in its own seed data. */
export const SEED_AUDITOR_ID = "auditor_1";

/** Finding ids whose PoC is seeded/designed to fail sandbox re-run, landing
 * the finding in Rejected instead of Verified. */
const FORCE_REJECT_FINDING_IDS = new Set<string>();

function timestamp(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

export function findAuditorById(auditorId: string): AuditorProfile | undefined {
  return db.auditorProfiles.find((a) => a.id === auditorId);
}

/** Findings whose stake lock outlives the claim, as in the real API. */
const LOCKING_STATUSES = new Set<Finding["status"]>(["Submitted", "Verified", "Disputed"]);

/** Findings whose outcome releases the claim lock at once, as in the real API
 * (PayoutCredited, a Failed verdict, a lost dispute). */
const RELEASING_STATUSES = new Set<Finding["status"]>(["Paid", "Rejected"]);

/** Mirrors AuditorStaking.activeSubmissions: one lock per contract the
 * auditor holds an unexpired claim on or has a pending finding on. A claim
 * whose PoC'd finding was paid or rejected no longer holds one. */
export function activeSubmissionsFor(auditorId: string): number {
  const locked = new Set<string>();
  const released = new Set<string>();
  const pocs = db.pocSubmissions.filter((p) => p.auditorId === auditorId);
  for (const poc of pocs) {
    const finding = findFindingById(poc.findingId);
    if (!finding) continue;
    if (LOCKING_STATUSES.has(finding.status)) locked.add(finding.contractId);
    else if (RELEASING_STATUSES.has(finding.status)) released.add(finding.contractId);
  }
  for (const [contractId, claim] of Object.entries(db.claims)) {
    if (
      claim.auditorId === auditorId &&
      new Date(claim.expiresAt).getTime() > Date.now() &&
      !released.has(contractId)
    ) {
      locked.add(contractId);
    }
  }
  return locked.size;
}

/** The profile as GET /api/auditor/profile returns it. */
export function profileView(auditor: AuditorProfile): AuditorProfile {
  return { ...auditor, activeSubmissions: activeSubmissionsFor(auditor.id) };
}

export interface QueueItem extends Contract {
  bounty: { amount: Wei; currency: string };
}

export function listQueue(sort?: "deadline" | "bounty" | "newest"): QueueItem[] {
  // Re-open abandoned claims, but preserve submissions already in verification.
  for (const contract of db.contracts.filter((c) => c.status === "Claimed")) {
    const findings = db.findings.filter((f) => f.contractId === contract.id);
    const expiresAt =
      db.claims[contract.id]?.expiresAt ?? findings.find((f) => f.claimExpiresAt)?.claimExpiresAt;
    if (
      expiresAt &&
      new Date(expiresAt).getTime() <= Date.now() &&
      !findings.some((f) => ["Submitted", "Verified", "Disputed", "Paid"].includes(f.status))
    ) {
      contract.status = new Date(contract.deadline).getTime() > Date.now() ? "Open" : "Expired";
      delete db.claims[contract.id];
      for (const finding of findings) {
        finding.claimedByAuditorId = null;
        finding.claimExpiresAt = null;
      }
      for (const auditor of db.auditorProfiles)
        auditor.claimedContractIds = auditor.claimedContractIds.filter((id) => id !== contract.id);
    }
  }
  const open = db.contracts.filter(
    (c) => c.status === "Open" && new Date(c.deadline).getTime() > Date.now(),
  );
  const items: QueueItem[] = open.map((c) => {
    const bounty = db.bounties.find((b) => b.contractId === c.id);
    return { ...c, bounty: { amount: bounty?.amount ?? "0", currency: bounty?.currency ?? "ETH" } };
  });
  if (sort === "deadline") {
    items.sort((a, b) => new Date(a.deadline).getTime() - new Date(b.deadline).getTime());
  } else if (sort === "bounty") {
    items.sort((a, b) => compareWei(b.bounty.amount, a.bounty.amount));
  } else if (sort === "newest") {
    items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }
  return items;
}

export function claimContract(contractId: string, auditorId: string): Contract {
  listQueue();
  const contract = findContractById(contractId);
  if (!contract) throw new MockApiError(404, `Contract ${contractId} not found`);
  if (contract.status !== "Open") {
    throw new MockApiError(409, `Contract ${contractId} is not open to claim`);
  }
  if (new Date(contract.deadline).getTime() <= Date.now())
    throw new MockApiError(400, "This bounty has expired");
  const auditor = findAuditorById(auditorId);
  if (!auditor) throw new MockApiError(404, `Auditor ${auditorId} not found`);

  contract.status = "Claimed";
  const claimExpiresAt = timestamp(CLAIM_WINDOW_MS);
  db.claims[contractId] = { auditorId, expiresAt: claimExpiresAt };
  for (const finding of db.findings.filter((f) => f.contractId === contractId)) {
    finding.claimedByAuditorId = auditorId;
    finding.claimExpiresAt = claimExpiresAt;
  }
  if (!auditor.claimedContractIds.includes(contractId)) {
    auditor.claimedContractIds.push(contractId);
  }
  return contract;
}

export function postStake(auditorId: string, amount: string): AuditorProfile {
  const auditor = findAuditorById(auditorId);
  if (!auditor) throw new MockApiError(404, `Auditor ${auditorId} not found`);
  if (!PositiveWeiSchema.safeParse(amount).success)
    throw new MockApiError(400, "Stake amount must be a positive wei amount");
  auditor.stake = (BigInt(auditor.stake) + BigInt(amount)).toString();
  return profileView(auditor);
}

export function withdrawStake(auditorId: string, amount: string): AuditorProfile {
  const auditor = findAuditorById(auditorId);
  if (!auditor) throw new MockApiError(404, `Auditor ${auditorId} not found`);
  if (!PositiveWeiSchema.safeParse(amount).success)
    throw new MockApiError(400, "Withdrawal amount must be a positive wei amount");
  if (activeSubmissionsFor(auditorId) > 0)
    throw new MockApiError(409, "Your stake is locked by an active claim or a pending finding");
  if (BigInt(amount) > BigInt(auditor.stake))
    throw new MockApiError(400, "Withdrawal amount exceeds your stake");
  auditor.stake = (BigInt(auditor.stake) - BigInt(amount)).toString();
  return profileView(auditor);
}

function resolveSandbox(pocId: string, findingId: string): void {
  const poc = db.pocSubmissions.find((p) => p.id === pocId);
  const finding = findFindingById(findingId);
  if (!poc || !finding) return;

  if (FORCE_REJECT_FINDING_IDS.has(findingId)) {
    poc.sandboxStatus = "Failed";
    poc.sandboxLog =
      "forge test: FAIL - exploit assertion did not revert as expected; PoC does not " +
      "reproduce the finding against the current contract state.";
    finding.status = "Rejected";
    finding.statusHistory.push({ status: "Rejected", changedAt: timestamp() });
    return;
  }

  poc.sandboxStatus = "Passed";
  poc.sandboxLog = "forge test: PASS - exploit reproduced, invariant violated as described.";
  finding.status = "Verified";
  finding.statusHistory.push({ status: "Verified", changedAt: timestamp() });
  armChallengeWindow(findingId);
}

export function submitPoc(
  findingId: string,
  auditorId: string,
  testFilename: string,
): PoCSubmission {
  const finding = findFindingById(findingId);
  if (!finding) throw new MockApiError(404, `Finding ${findingId} not found`);
  if (finding.status !== "Flagged") {
    throw new MockApiError(400, `Finding ${findingId} is not awaiting a PoC`);
  }
  if (
    finding.claimedByAuditorId !== auditorId ||
    !finding.claimExpiresAt ||
    new Date(finding.claimExpiresAt).getTime() <= Date.now()
  )
    throw new MockApiError(409, "An active claim is required");
  if (compareWei(findAuditorById(auditorId)?.stake ?? "0", ethToWei("10000")) < 0)
    throw new MockApiError(400, "Post the required demo stake before submitting a PoC");
  const contract = findContractById(finding.contractId);
  if (
    !contract ||
    contract.status !== "Claimed" ||
    new Date(contract.deadline).getTime() <= Date.now()
  )
    throw new MockApiError(400, "This bounty is no longer accepting submissions");

  const pocId = nextId("poc");
  const poc: PoCSubmission = {
    id: pocId,
    findingId,
    auditorId,
    testFileReference: `mock://pocs/${pocId}/${testFilename}`,
    submittedAt: timestamp(),
    sandboxStatus: "Pending",
    sandboxLog: null,
  };
  db.pocSubmissions.push(poc);

  finding.status = "Submitted";
  finding.statusHistory.push({ status: "Submitted", changedAt: timestamp() });

  scheduleOnce(`sandbox:${pocId}`, SANDBOX_DELAY_MS, () => resolveSandbox(pocId, findingId));

  return poc;
}

/** The contract's claim: db.claims for claims made at runtime, else the
 * claim fields seeded onto its findings. */
function activeClaimFor(contractId: string): { auditorId: string; expiresAt: string } | null {
  const claim =
    db.claims[contractId] ??
    db.findings
      .filter((f) => f.contractId === contractId && f.claimedByAuditorId && f.claimExpiresAt)
      .map((f) => ({ auditorId: f.claimedByAuditorId!, expiresAt: f.claimExpiresAt! }))[0];
  if (!claim || new Date(claim.expiresAt).getTime() <= Date.now()) return null;
  return claim;
}

export interface ReportFindingInput {
  contractId: string;
  title: string;
  severity: string;
  description: string;
}

/** POST /api/auditor/findings: the claiming auditor reports a finding Slither
 * missed, with its PoC. Same checks as submitPoc; the finding starts
 * Submitted and the sandbox resolves it like any other PoC. */
/** The API's 400 issues for a report: the text fields, then the PoC file
 * (POST /api/auditor/findings, apps/api/src/pipeline/routes.ts). */
export function reportFindingIssues(
  input: ReportFindingInput,
  file: { name: string; size: number },
): string[] {
  return [
    ...(AuditorFindingFieldsSchema.safeParse(input).error?.issues ?? []),
    ...(PocSourceFilenameSchema.safeParse(file.name).error?.issues ?? []),
    ...(PocSourceSizeSchema.safeParse(file.size).error?.issues ?? []),
  ].map((issue) => issue.message);
}

/** Same checks, order and statuses as the API: 400 invalid report, 404
 * unknown contract, 403 no active claim, 403 stake below the demo
 * requirement. The handler answers 413 for an oversize file before this. */
export function reportFinding(
  input: ReportFindingInput,
  auditorId: string,
  file: { name: string; size: number },
): AuditorFindingReport {
  if (reportFindingIssues(input, file).length > 0) {
    throw new MockApiError(400, "Invalid finding report");
  }
  const report = AuditorFindingFieldsSchema.parse(input);
  const contract = findContractById(report.contractId);
  if (!contract) throw new MockApiError(404, "Not found");
  const claim = contract.status === "Claimed" ? activeClaimFor(contract.id) : null;
  if (!claim || claim.auditorId !== auditorId)
    throw new MockApiError(403, "You do not hold an active claim on this contract");
  if (compareWei(findAuditorById(auditorId)?.stake ?? "0", ethToWei("10000")) < 0)
    throw new MockApiError(403, "Auditor stake is below the required stake");
  const testFilename = file.name;

  const findingId = nextId("finding");
  const at = timestamp();
  const finding: Finding = {
    id: findingId,
    contractId: contract.id,
    severity: report.severity,
    slitherDetector: AUDITOR_FINDING_DETECTOR,
    rawOutputReference: `mock://auditor-reports/${findingId}.json`,
    llmExplanation: report.description,
    status: "Submitted",
    statusHistory: [{ status: "Submitted", changedAt: at }],
    claimedByAuditorId: claim.auditorId,
    claimExpiresAt: claim.expiresAt,
    isFalsePositive: false,
    challengeWindowExpiresAt: null,
    source: "auditor",
    title: report.title,
    reportedByAuditorId: auditorId,
    developerNote: null,
    developerNoteUpdatedAt: null,
  };
  db.findings.push(finding);

  const pocId = nextId("poc");
  const poc: PoCSubmission = {
    id: pocId,
    findingId,
    auditorId,
    testFileReference: `mock://pocs/${pocId}/${testFilename}`,
    submittedAt: at,
    sandboxStatus: "Pending",
    sandboxLog: null,
  };
  db.pocSubmissions.push(poc);
  scheduleOnce(`sandbox:${pocId}`, SANDBOX_DELAY_MS, () => resolveSandbox(pocId, findingId));
  return { finding, poc };
}

export function markFalsePositive(findingId: string, _auditorId: string): Finding {
  const finding = findFindingById(findingId);
  if (!finding) throw new MockApiError(404, `Finding ${findingId} not found`);
  finding.isFalsePositive = true;
  finding.status = "Rejected";
  finding.statusHistory.push({ status: "Rejected", changedAt: timestamp() });
  return finding;
}

export function seedAuditorsArea(): void {
  db.auditorProfiles.push({
    id: SEED_AUDITOR_ID,
    address: MOCK_ADDRESSES.auditor,
    stake: ethToWei("5000"),
    reputation: 12,
    claimedContractIds: ["contract_2", "contract_3"],
  });

  // poc_1: already Passed, backing finding_3 (the Verified/auto-pay demo).
  db.pocSubmissions.push({
    id: nextId("poc"),
    findingId: "finding_3",
    auditorId: SEED_AUDITOR_ID,
    testFileReference: "mock://pocs/poc_1/ReentrancyExploit.t.sol",
    submittedAt: new Date(Date.now() - 15_000).toISOString(),
    sandboxStatus: "Passed",
    sandboxLog: "forge test: PASS - exploit reproduced, invariant violated as described.",
  });

  // poc_2: Pending against finding_4, seeded to resolve Failed in ~3s -
  // the "sandbox rejects it" scenario.
  const pendingPocId = nextId("poc");
  db.pocSubmissions.push({
    id: pendingPocId,
    findingId: "finding_4",
    auditorId: SEED_AUDITOR_ID,
    testFileReference: "mock://pocs/poc_2/SelfdestructExploit.t.sol",
    submittedAt: new Date(Date.now() - 1_000).toISOString(),
    sandboxStatus: "Pending",
    sandboxLog: null,
  });
  FORCE_REJECT_FINDING_IDS.add("finding_4");
  scheduleOnce(`sandbox:${pendingPocId}`, SANDBOX_DELAY_MS, () =>
    resolveSandbox(pendingPocId, "finding_4"),
  );

  // poc_3: Passed, backing finding_5 (already Disputed - seeded in
  // db/disputes.ts) so the arbiter has a sandbox log to review.
  db.pocSubmissions.push({
    id: nextId("poc"),
    findingId: "finding_5",
    auditorId: SEED_AUDITOR_ID,
    testFileReference: "mock://pocs/poc_3/UnusedReturnExploit.t.sol",
    submittedAt: new Date(Date.now() - 50_000).toISOString(),
    sandboxStatus: "Passed",
    sandboxLog: "forge test: PASS - exploit reproduced, invariant violated as described.",
  });
}
