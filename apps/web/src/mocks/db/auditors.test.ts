import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Finding } from "@bbm/shared";
import {
  SEED_AUDITOR_ID,
  activeSubmissionsFor,
  cancelAllScheduled,
  db,
  findAuditorById,
  reportFinding,
  resetMockDb,
} from "@/mocks/db";
import { ethToWei } from "@/lib/money";

const CONTRACT = "contract_lock_test";

beforeEach(() => {
  resetMockDb();
  // Start from no locks, so each case sets up exactly one claim.
  db.claims = {};
  db.pocSubmissions = [];
});

afterEach(() => {
  cancelAllScheduled();
});

/** An unexpired claim on CONTRACT by the seed auditor, with one finding in
 * `status` backed by the auditor's PoC. */
function claimWith(status: Finding["status"], history: Finding["status"][] = [status]) {
  db.claims[CONTRACT] = {
    auditorId: SEED_AUDITOR_ID,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const finding: Finding = {
    ...structuredClone(db.findings[0]!),
    id: "finding_lock_test",
    contractId: CONTRACT,
    status,
    statusHistory: history.map((s) => ({ status: s, changedAt: new Date().toISOString() })),
  };
  db.findings.push(finding);
  db.pocSubmissions.push({
    id: "poc_lock_test",
    findingId: finding.id,
    auditorId: SEED_AUDITOR_ID,
    testFileReference: "mock://pocs/poc_lock_test/X.t.sol",
    submittedAt: new Date().toISOString(),
    sandboxStatus: "Passed",
    sandboxLog: null,
  });
}

describe("activeSubmissionsFor", () => {
  it.each(["Flagged", "Submitted", "Verified", "Disputed"] as const)(
    "counts an unexpired claim whose finding is %s",
    (status) => {
      claimWith(status);
      expect(activeSubmissionsFor(SEED_AUDITOR_ID)).toBe(1);
    },
  );

  it("releases the lock once the auditor's finding is Paid, even with the claim unexpired", () => {
    // The real API unlocks on PayoutCredited without waiting for the expiry.
    claimWith("Paid");
    expect(activeSubmissionsFor(SEED_AUDITOR_ID)).toBe(0);
  });

  it("releases the lock once a dispute goes against the auditor, even with the claim unexpired", () => {
    claimWith("Rejected", ["Submitted", "Verified", "Disputed", "Rejected"]);
    expect(activeSubmissionsFor(SEED_AUDITOR_ID)).toBe(0);
  });

  it("keeps the lock of an unexpired claim after a Failed verdict", () => {
    // The auditor may still submit on the claim, and that finding's
    // verification needs the stake: the real API keeps the lock until expiry.
    claimWith("Rejected", ["Submitted", "Rejected"]);
    expect(activeSubmissionsFor(SEED_AUDITOR_ID)).toBe(1);
  });

  it("counts an auditor-reported finding past the claim's expiry", () => {
    // contract_2 is seeded Claimed by the seed auditor (claim on its findings).
    findAuditorById(SEED_AUDITOR_ID)!.stake = ethToWei("10000");
    const { finding } = reportFinding(
      {
        contractId: "contract_2",
        title: "Unprotected sweep()",
        severity: "High",
        description: "Anyone can sweep the balance.",
      },
      SEED_AUDITOR_ID,
      { name: "Sweep.t.sol", size: 20 },
    );
    // Even with every claim gone, the Submitted report holds the stake.
    db.claims = {};
    expect(finding.status).toBe("Submitted");
    expect(activeSubmissionsFor(SEED_AUDITOR_ID)).toBe(1);
  });
});
