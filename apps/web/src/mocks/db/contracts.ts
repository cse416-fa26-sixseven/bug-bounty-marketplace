import {
  DeveloperNoteInputSchema,
  type AnalysisStatus,
  type Bounty,
  type Contract,
  type ContractStatus,
  type Finding,
  type FindingSeverity,
} from "@bbm/shared";
import { MOCK_ADDRESSES } from "../../lib/addresses";
import { ethToWei } from "../../lib/money";
import { db } from "./store";
import { nextId } from "./ids";
import { scheduleOnce, cancelScheduled } from "./scheduler";
import { ANALYSIS_DELAY_MS, CHALLENGE_WINDOW_MS } from "./timing";
import { MockApiError } from "./errors";
import { SEED_AUDITOR_ID } from "./auditors";

const DETECTOR_POOL: Array<{ severity: FindingSeverity; detector: string; explanation: string }> = [
  {
    severity: "Critical",
    detector: "reentrancy-eth",
    explanation:
      "An external call is made before the contract's own state is updated, allowing a " +
      "malicious callee to re-enter and drain ETH before balances are settled.",
  },
  {
    severity: "High",
    detector: "unprotected-selfdestruct",
    explanation:
      "A function that can call selfdestruct is reachable without an access-control check, " +
      "letting any caller destroy the contract and sweep its balance.",
  },
  {
    severity: "Medium",
    detector: "unchecked-transfer",
    explanation:
      "The return value of an ERC-20 transfer/transferFrom call is not checked, so a " +
      "silently-failing token transfer would be treated as successful.",
  },
  {
    severity: "Low",
    detector: "unused-return",
    explanation:
      "A low-level call's return value is discarded, hiding a potential failure from " +
      "downstream logic.",
  },
];

function timestamp(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function newFindingShell(contractId: string, pick: (typeof DETECTOR_POOL)[number]): Finding {
  const now = timestamp(0);
  return {
    id: nextId("finding"),
    contractId,
    severity: pick.severity,
    slitherDetector: pick.detector,
    rawOutputReference: `mock://slither/${contractId}/${pick.detector}.json`,
    llmExplanation: pick.explanation,
    status: "Flagged",
    statusHistory: [{ status: "Flagged", changedAt: now }],
    claimedByAuditorId: null,
    claimExpiresAt: null,
    isFalsePositive: false,
    source: "slither",
    title: null,
    reportedByAuditorId: null,
    developerNote: null,
    developerNoteUpdatedAt: null,
    challengeWindowExpiresAt: null,
  };
}

/** Generates 1-2 Flagged findings for a freshly-submitted contract. Used
 * both by the ~3s post-submission analysis timer and directly by seeding. */
export function generateFindingsForContract(contractId: string, count = 2): Finding[] {
  const picks = DETECTOR_POOL.slice(0, count);
  const findings = picks.map((pick) => newFindingShell(contractId, pick));
  const claim = db.claims[contractId];
  if (claim) {
    for (const finding of findings) {
      finding.claimedByAuditorId = claim.auditorId;
      finding.claimExpiresAt = claim.expiresAt;
    }
  }
  db.findings.push(...findings);
  return findings;
}

/** A mock upload whose filename contains this (any case) fails analysis the
 * way a contract that does not compile does: no findings, never fundable or
 * claimable. */
export const FAILING_ANALYSIS_MARKER = "broken";

const MOCK_COMPILER_ERROR =
  "ParserError: Expected ';' but got '}'\n --> {file}:7:1:\n  |\n7 | }\n  | ^";

/** Analysis runs still in flight or failed. A contract with no entry has a
 * finished (Done) analysis, as every seeded contract but contract_1 does. */
const analysisRuns = new Map<string, { status: "Running" | "Failed"; error: string | null; updatedAt: string }>();

/** Starts the simulated Slither + LLM analysis: findings land ~3s later, or
 * the run fails for a FAILING_ANALYSIS_MARKER filename. */
function startAnalysis(contractId: string, filename: string): void {
  analysisRuns.set(contractId, { status: "Running", error: null, updatedAt: timestamp(0) });
  scheduleOnce(`analysis:${contractId}`, ANALYSIS_DELAY_MS, () => {
    if (filename.toLowerCase().includes(FAILING_ANALYSIS_MARKER)) {
      analysisRuns.set(contractId, {
        status: "Failed",
        error: MOCK_COMPILER_ERROR.replace("{file}", filename),
        updatedAt: timestamp(0),
      });
      return;
    }
    generateFindingsForContract(contractId);
    analysisRuns.delete(contractId);
  });
}

/** Finishes the contract's analysis now, with no findings (a clean report).
 * For tests and fixtures that need a contract auditors can claim. */
export function completeAnalysisClean(contractId: string): void {
  cancelScheduled(`analysis:${contractId}`);
  analysisRuns.delete(contractId);
}

/** Mirrors GET /api/contracts/:id/analysis. */
export function analysisStatusFor(contract: Contract): AnalysisStatus {
  const run = analysisRuns.get(contract.id);
  return {
    contractId: contract.id,
    status: run?.status ?? "Done",
    error: run?.error ?? null,
    findingCount: listFindingsByContract(contract.id).length,
    updatedAt: run?.updatedAt ?? contract.createdAt,
  };
}

/** True once the contract's analysis finished, as the API requires before
 * funding or claiming. */
export function isAnalysisDone(contractId: string): boolean {
  return !analysisRuns.has(contractId);
}

export function findBountyByContract(contractId: string): Bounty | undefined {
  return db.bounties.find((b) => b.contractId === contractId);
}

export function findContractById(contractId: string): Contract | undefined {
  return db.contracts.find((c) => c.id === contractId);
}

export function listContracts(filter?: { developerAddress?: string }): Contract[] {
  if (filter?.developerAddress) {
    return db.contracts.filter((c) => c.developerAddress === filter.developerAddress);
  }
  return [...db.contracts];
}

export function listFindingsByContract(contractId: string): Finding[] {
  return db.findings.filter((f) => f.contractId === contractId);
}

export function findFindingById(findingId: string): Finding | undefined {
  return db.findings.find((f) => f.id === findingId);
}

export interface CreateContractInput {
  developerAddress: string;
  filename: string;
  /** sha256 hex digest of the uploaded source bytes. */
  sourceHash: string;
  /** Wei as a decimal string. */
  bountyAmount: string;
  currency: string;
  deadline: string;
}

export function createContract(input: CreateContractInput): Contract {
  const contractId = nextId("contract");
  const bountyId = nextId("bounty");
  const now = timestamp(0);

  db.bounties.push({
    id: bountyId,
    contractId,
    amount: input.bountyAmount,
    currency: input.currency,
    fundedAt: now,
    deadline: input.deadline,
  });

  const contract: Contract = {
    id: contractId,
    developerAddress: input.developerAddress,
    filename: input.filename,
    sourceHash: input.sourceHash,
    // Same storage key format as the API (apps/api/src/contracts/service.ts).
    sourceReference: `contracts/${contractId}/${input.sourceHash}.sol`,
    bountyId,
    status: "Open",
    createdAt: now,
    deadline: input.deadline,
  };
  db.contracts.push(contract);
  startAnalysis(contractId, input.filename);
  return contract;
}

function setContractStatus(contractId: string, status: ContractStatus): void {
  const contract = findContractById(contractId);
  if (!contract) throw new MockApiError(404, `Contract ${contractId} not found`);
  contract.status = status;
}

/** Cancels a bounty submission before any auditor has engaged with it.
 * Only valid while the contract is still `Open` (i.e. unclaimed) - once an
 * auditor claims it (status flips to `Claimed`) there's a submission in
 * flight and cancellation is no longer allowed. */
export function cancelContract(contractId: string): Contract {
  const contract = findContractById(contractId);
  if (!contract) throw new MockApiError(404, `Contract ${contractId} not found`);
  if (contract.status !== "Open") {
    throw new MockApiError(400, "Only an open, unclaimed contract can be cancelled");
  }
  cancelScheduled(`analysis:${contractId}`);
  setContractStatus(contractId, "Expired");
  return contract;
}

export function reclaimContract(contractId: string): Contract {
  const contract = findContractById(contractId);
  if (!contract) throw new MockApiError(404, `Contract ${contractId} not found`);
  if (new Date(contract.deadline).getTime() > Date.now()) {
    throw new MockApiError(400, "Bounty deadline has not passed yet");
  }
  if (contract.status === "Resolved") {
    throw new MockApiError(400, "Contract already resolved, nothing to reclaim");
  }
  setContractStatus(contractId, "Expired");
  return contract;
}

/** Arms the ~30s challenge window on a Verified finding: if nothing disputes
 * it before the window elapses, the finding auto-transitions to Paid. */
export function armChallengeWindow(findingId: string): void {
  const finding = findFindingById(findingId);
  if (!finding) return;
  const expiresAt = timestamp(CHALLENGE_WINDOW_MS);
  finding.challengeWindowExpiresAt = expiresAt;

  scheduleOnce(`autopay:${findingId}`, CHALLENGE_WINDOW_MS, () => {
    const current = findFindingById(findingId);
    if (!current || current.status !== "Verified") return; // disputed/rejected meanwhile
    current.status = "Paid";
    current.statusHistory.push({ status: "Paid", changedAt: timestamp(0) });
    const owningContract = findContractById(current.contractId);
    if (owningContract) owningContract.status = "Resolved";
  });
}

export function cancelChallengeWindow(findingId: string): void {
  cancelScheduled(`autopay:${findingId}`);
}

export function disputeFinding(findingId: string, _developerId: string): Finding {
  const finding = findFindingById(findingId);
  if (!finding) throw new MockApiError(404, `Finding ${findingId} not found`);
  if (finding.status !== "Verified") {
    throw new MockApiError(400, "Only a Verified finding can be disputed");
  }
  if (
    !finding.challengeWindowExpiresAt ||
    new Date(finding.challengeWindowExpiresAt).getTime() <= Date.now()
  ) {
    throw new MockApiError(400, "Challenge window has already closed");
  }
  cancelChallengeWindow(findingId);
  finding.status = "Disputed";
  finding.statusHistory.push({ status: "Disputed", changedAt: timestamp(0) });
  return finding;
}

/** PUT /api/findings/:id/note: only the contract's developer may write; a
 * blank or null note clears it. */
export function setFindingNote(findingId: string, developerId: string, note: unknown): Finding {
  const parsed = DeveloperNoteInputSchema.safeParse({ note });
  if (!parsed.success) {
    throw new MockApiError(400, parsed.error.issues.map((i) => i.message).join("; "));
  }
  const finding = findFindingById(findingId);
  if (!finding) throw new MockApiError(404, "Not found");
  const contract = findContractById(finding.contractId);
  if (contract?.developerAddress.toLowerCase() !== developerId.toLowerCase()) {
    throw new MockApiError(403, "Only the contract's developer can edit this note");
  }
  finding.developerNote = parsed.data.note;
  finding.developerNoteUpdatedAt = parsed.data.note === null ? null : timestamp(0);
  return finding;
}

export function seedContractsArea(): void {
  analysisRuns.clear();
  const now = Date.now();
  const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();
  const DAY = 86_400_000;

  // --- contract_1: just submitted, analysis still "running" (no findings
  // yet) ---
  const contract1Id = nextId("contract");
  const bounty1Id = nextId("bounty");
  db.bounties.push({
    id: bounty1Id,
    contractId: contract1Id,
    amount: ethToWei("2"),
    currency: "ETH",
    fundedAt: iso(-60_000),
    deadline: iso(30 * DAY),
  });
  db.contracts.push({
    id: contract1Id,
    developerAddress: MOCK_ADDRESSES.developer,
    filename: "Vault.sol",
    sourceHash: "mock-sha256-contract_1",
    sourceReference: "mock://sources/contract_1/Vault.sol",
    bountyId: bounty1Id,
    status: "Open",
    createdAt: iso(-60_000),
    deadline: iso(30 * DAY),
  });

  // --- contract_2: claimed by the seed auditor, two Flagged findings ---
  const contract2Id = nextId("contract");
  const bounty2Id = nextId("bounty");
  db.bounties.push({
    id: bounty2Id,
    contractId: contract2Id,
    amount: ethToWei("5"),
    currency: "ETH",
    fundedAt: iso(-2 * DAY),
    deadline: iso(28 * DAY),
  });
  db.contracts.push({
    id: contract2Id,
    developerAddress: MOCK_ADDRESSES.developer,
    filename: "Staking.sol",
    sourceHash: "mock-sha256-contract_2",
    sourceReference: "mock://sources/contract_2/Staking.sol",
    bountyId: bounty2Id,
    status: "Claimed",
    createdAt: iso(-2 * DAY),
    deadline: iso(28 * DAY),
  });
  const claim2ExpiresAt = iso(10 * 60_000);
  for (const pick of DETECTOR_POOL.slice(0, 2)) {
    const finding = newFindingShell(contract2Id, pick);
    finding.claimedByAuditorId = SEED_AUDITOR_ID;
    finding.claimExpiresAt = claim2ExpiresAt;
    db.findings.push(finding);
  }

  // --- contract_3: claimed, further along - one Verified finding (auto-pay
  // happy path) and one Submitted finding (seeded failing PoC, wired up in
  // db/auditors.ts) and one already-Disputed finding (seeded in
  // db/disputes.ts) ---
  const contract3Id = nextId("contract");
  const bounty3Id = nextId("bounty");
  db.bounties.push({
    id: bounty3Id,
    contractId: contract3Id,
    amount: ethToWei("3"),
    currency: "ETH",
    fundedAt: iso(-5 * DAY),
    deadline: iso(25 * DAY),
  });
  db.contracts.push({
    id: contract3Id,
    developerAddress: MOCK_ADDRESSES.developer,
    filename: "LendingPool.sol",
    sourceHash: "mock-sha256-contract_3",
    sourceReference: "mock://sources/contract_3/LendingPool.sol",
    bountyId: bounty3Id,
    status: "Claimed",
    createdAt: iso(-5 * DAY),
    deadline: iso(25 * DAY),
  });
  const claim3ExpiresAt = iso(10 * 60_000);

  // finding_3: Verified -> challenge window armed -> auto-pay in ~30s
  const findingVerified = newFindingShell(contract3Id, DETECTOR_POOL[0]!);
  findingVerified.claimedByAuditorId = SEED_AUDITOR_ID;
  findingVerified.claimExpiresAt = claim3ExpiresAt;
  findingVerified.status = "Verified";
  findingVerified.statusHistory.push(
    { status: "Submitted", changedAt: iso(-30_000) },
    { status: "Verified", changedAt: iso(-15_000) },
  );
  db.findings.push(findingVerified);
  armChallengeWindow(findingVerified.id);

  // finding_4: Submitted, PoC pending -> will resolve Failed -> Rejected
  // (seeded + scheduled in db/auditors.ts, which creates the PoCSubmission).
  const findingPendingFail = newFindingShell(contract3Id, DETECTOR_POOL[1]!);
  findingPendingFail.claimedByAuditorId = SEED_AUDITOR_ID;
  findingPendingFail.claimExpiresAt = claim3ExpiresAt;
  findingPendingFail.status = "Submitted";
  findingPendingFail.statusHistory.push({ status: "Submitted", changedAt: iso(-5_000) });
  db.findings.push(findingPendingFail);

  // finding_5: already Disputed (seeded dispute lives in db/disputes.ts).
  const findingDisputed = newFindingShell(contract3Id, DETECTOR_POOL[2]!);
  findingDisputed.claimedByAuditorId = SEED_AUDITOR_ID;
  findingDisputed.claimExpiresAt = claim3ExpiresAt;
  findingDisputed.status = "Disputed";
  findingDisputed.statusHistory.push(
    { status: "Submitted", changedAt: iso(-60_000) },
    { status: "Verified", changedAt: iso(-45_000) },
    { status: "Disputed", changedAt: iso(-10_000) },
  );
  db.findings.push(findingDisputed);
  // Keep the open seed usable: analysis must complete just as it does
  // for a new upload. Schedule after all seeds so fixture IDs stay stable.
  startAnalysis(contract1Id, "Vault.sol");
}
