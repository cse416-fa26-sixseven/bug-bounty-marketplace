import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetMockDb, cancelAllScheduled } from "@/mocks/db";
import { developerApi, auditorApi } from "@/lib/api";
import { ethToWei } from "@/lib/money";

const SEED_AUDITOR_ID = "auditor_1";
const SEED_DEVELOPER_ADDRESS = `0x${"d1".repeat(20)}`;

beforeEach(() => {
  // Only fake setTimeout/clearTimeout (what our scheduler uses) - leaving
  // setImmediate/queueMicrotask/process.nextTick real so Node's fetch/undici
  // (used by MSW's node interceptor under the hood) isn't starved while we
  // fast-forward virtual time.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  // Reseed under fake timers so every scheduled transition (analysis,
  // sandbox, challenge window) is driven by vi.advanceTimersByTimeAsync
  // rather than real wall-clock time.
  resetMockDb();
});

afterEach(() => {
  cancelAllScheduled();
  vi.useRealTimers();
});

describe("contract submission -> analysis", () => {
  it("has no findings immediately, then Flagged findings ~3s later", async () => {
    const file = new File(["contract Foo {}"], "Foo.sol", { type: "text/plain" });
    const contract = await developerApi.submitContract({
      file,
      developerAddress: SEED_DEVELOPER_ADDRESS,
      bountyAmount: "1000000000000000000",
      deadline: new Date(Date.now() + 86_400_000).toISOString(),
    });

    expect(contract.status).toBe("Open");
    expect(await developerApi.listFindings(contract.id)).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(3_000);

    const findings = await developerApi.listFindings(contract.id);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((f) => f.status === "Flagged")).toBe(true);
  });
});

describe("seeded Verified finding -> auto-pay happy path", () => {
  it("auto-transitions to Paid once the 30s challenge window elapses undisputed", async () => {
    const findings = await developerApi.listFindings("contract_3");
    const verified = findings.find((f) => f.status === "Verified");
    expect(verified).toBeDefined();
    expect(verified?.challengeWindowExpiresAt).not.toBeNull();

    await vi.advanceTimersByTimeAsync(30_000);

    const after = await developerApi.listFindings("contract_3");
    expect(after.find((f) => f.id === verified!.id)?.status).toBe("Paid");
  });

  it("cancels the pending auto-pay when the developer disputes within the window", async () => {
    const findings = await developerApi.listFindings("contract_3");
    const verified = findings.find((f) => f.status === "Verified");
    expect(verified).toBeDefined();

    const dispute = await developerApi.disputeFinding(verified!.id, {
      developerId: SEED_DEVELOPER_ADDRESS,
      reason: "The PoC's assumptions don't hold against the real token implementation.",
    });
    expect(dispute.ruling).toBe("Pending");

    await vi.advanceTimersByTimeAsync(30_000);

    const after = await developerApi.listFindings("contract_3");
    expect(after.find((f) => f.id === verified!.id)?.status).toBe("Disputed");
  });
});

describe("seeded failing PoC", () => {
  it("resolves to Rejected once the sandbox finishes", async () => {
    const findings = await developerApi.listFindings("contract_3");
    const pending = findings.find((f) => f.status === "Submitted");
    expect(pending).toBeDefined();

    await vi.advanceTimersByTimeAsync(3_000);

    const after = await developerApi.listFindings("contract_3");
    expect(after.find((f) => f.id === pending!.id)?.status).toBe("Rejected");
  });
});

describe("auditor queue + claim", () => {
  it("lists the open contract and lets the seed auditor claim it", async () => {
    const queue = await auditorApi.listQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0]?.status).toBe("Open");

    const claimed = await auditorApi.claimContract({
      contractId: queue[0]!.id,
      auditorId: SEED_AUDITOR_ID,
    });
    expect(claimed.status).toBe("Claimed");

    expect(await auditorApi.listQueue()).toHaveLength(0);
  });
});

describe("developer notes on findings", () => {
  it("lets the contract's developer set, edit and clear a note", async () => {
    const finding = (await developerApi.listFindings("contract_2"))[0]!;
    const set = await developerApi.setFindingNote(finding.id, {
      developerId: SEED_DEVELOPER_ADDRESS,
      note: "  Known issue  ",
    });
    expect(set).toMatchObject({ developerNote: "Known issue" });
    expect(set.developerNoteUpdatedAt).not.toBeNull();
    await developerApi.setFindingNote(finding.id, {
      developerId: SEED_DEVELOPER_ADDRESS,
      note: "Fixed in v2",
    });
    expect((await developerApi.listFindings("contract_2"))[0]?.developerNote).toBe("Fixed in v2");
    const cleared = await developerApi.setFindingNote(finding.id, {
      developerId: SEED_DEVELOPER_ADDRESS,
      note: "",
    });
    expect(cleared).toMatchObject({ developerNote: null, developerNoteUpdatedAt: null });
  });

  it("rejects a note from anyone else, an over-long note, and an unknown finding", async () => {
    const finding = (await developerApi.listFindings("contract_2"))[0]!;
    await expect(
      developerApi.setFindingNote(finding.id, { developerId: SEED_AUDITOR_ID, note: "x" }),
    ).rejects.toThrow(/Only the contract's developer/);
    await expect(
      developerApi.setFindingNote(finding.id, {
        developerId: SEED_DEVELOPER_ADDRESS,
        note: "a".repeat(2001),
      }),
    ).rejects.toThrow(/at most 2000/);
    await expect(
      developerApi.setFindingNote("finding_missing", {
        developerId: SEED_DEVELOPER_ADDRESS,
        note: "x",
      }),
    ).rejects.toThrow(/Not found/);
    expect((await developerApi.listFindings("contract_2"))[0]?.developerNote).toBeNull();
  });
});

describe("claim during analysis", () => {
  it("assigns later findings to the auditor who claimed before analysis completed", async () => {
    const contract = await developerApi.submitContract({
      file: new File(["contract Demo {}"], "Demo.sol"),
      developerAddress: SEED_DEVELOPER_ADDRESS,
      bountyAmount: "1000000000000000000",
      deadline: new Date(Date.now() + 86_400_000).toISOString(),
    });
    await auditorApi.claimContract({ contractId: contract.id, auditorId: SEED_AUDITOR_ID });
    await vi.advanceTimersByTimeAsync(3000);
    const findings = await developerApi.listFindings(contract.id);
    expect(findings).toHaveLength(2);
    expect(
      findings.every((f) => f.claimedByAuditorId === SEED_AUDITOR_ID && !!f.claimExpiresAt),
    ).toBe(true);
  });
  it("completes analysis for the seeded open contract", async () => {
    await vi.advanceTimersByTimeAsync(3000);
    expect(await developerApi.listFindings("contract_1")).toHaveLength(2);
  });
});

describe("complete demo bounty lifecycle", () => {
  it("accepts a staked PoC, verifies it, and pays after the challenge window", async () => {
    await auditorApi.postStake({ auditorId: SEED_AUDITOR_ID, amount: ethToWei("5000") });
    const finding = (await developerApi.listFindings("contract_2"))[0]!;
    await auditorApi.submitPoc({
      findingId: finding.id,
      auditorId: SEED_AUDITOR_ID,
      file: new File(["contract Proof {}"], "Proof.t.sol"),
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect((await developerApi.listFindings("contract_2"))[0]?.status).toBe("Verified");
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await developerApi.listFindings("contract_2"))[0]?.status).toBe("Paid");
    expect((await developerApi.getContract("contract_2")).status).toBe("Resolved");
  });
  it("verifies and pays an auditor-reported finding through the same sandbox path", async () => {
    await auditorApi.postStake({ auditorId: SEED_AUDITOR_ID, amount: ethToWei("5000") });
    const { finding, poc } = await auditorApi.reportFinding({
      contractId: "contract_2",
      auditorId: SEED_AUDITOR_ID,
      title: "Unprotected sweep()",
      severity: "Critical",
      description: "Anyone can call sweep() and take the whole balance.",
      file: new File(["contract SweepTest {}"], "Sweep.t.sol"),
    });
    expect(finding).toMatchObject({
      source: "auditor",
      status: "Submitted",
      reportedByAuditorId: SEED_AUDITOR_ID,
      claimedByAuditorId: SEED_AUDITOR_ID,
    });
    expect(poc).toMatchObject({ findingId: finding.id, sandboxStatus: "Pending" });
    await vi.advanceTimersByTimeAsync(3000);
    const listed = (await developerApi.listFindings("contract_2")).find((f) => f.id === finding.id);
    expect(listed?.status).toBe("Verified");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(
      (await developerApi.listFindings("contract_2")).find((f) => f.id === finding.id)?.status,
    ).toBe("Paid");
  });
  it("rejects an auditor report without the claim, the stake, or a valid title", async () => {
    const report = {
      contractId: "contract_2",
      auditorId: SEED_AUDITOR_ID,
      title: "Unprotected sweep()",
      severity: "High" as const,
      description: "d",
      file: new File(["contract SweepTest {}"], "Sweep.t.sol"),
    };
    await expect(auditorApi.reportFinding(report)).rejects.toThrow(/stake/);
    await auditorApi.postStake({ auditorId: SEED_AUDITOR_ID, amount: ethToWei("5000") });
    await expect(auditorApi.reportFinding({ ...report, auditorId: "auditor_x" })).rejects.toThrow(
      /active claim/,
    );
    await expect(auditorApi.reportFinding({ ...report, title: "  " })).rejects.toThrow(
      /Title is required/,
    );
    await expect(auditorApi.reportFinding({ ...report, contractId: "contract_1" })).rejects.toThrow(
      /active claim/,
    );
    expect((await developerApi.listFindings("contract_2")).some((f) => f.source === "auditor")).toBe(
      false,
    );
  });
  it("does not allow a PoC without the required stake", async () => {
    const finding = (await developerApi.listFindings("contract_2"))[0]!;
    await expect(
      auditorApi.submitPoc({
        findingId: finding.id,
        auditorId: SEED_AUDITOR_ID,
        file: new File(["contract Proof {}"], "Proof.t.sol"),
      }),
    ).rejects.toThrow(/stake/);
  });
});
