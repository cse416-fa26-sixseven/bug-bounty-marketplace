import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ANALYSIS_DELAY_MS, cancelAllScheduled, isAnalysisDone, resetMockDb } from "@/mocks/db";
import { developerApi } from "@/lib/api";

beforeEach(() => {
  resetMockDb();
});

afterEach(() => {
  cancelAllScheduled();
});

describe("mock GET /api/contracts/:id/analysis", () => {
  it("reports Running before the mocked analysis has produced findings", async () => {
    const contract = await developerApi.submitContract({
      file: new File(["pragma solidity ^0.8.19;\ncontract A {}\n"], "A.sol"),
      developerAddress: `0x${"d1".repeat(20)}`,
      bountyAmount: "1000000000000000000",
      deadline: "2030-01-01T00:00:00.000Z",
    });
    const running = await developerApi.getAnalysisStatus(contract.id);
    expect(running).toMatchObject({ contractId: contract.id, status: "Running", findingCount: 0 });
  });

  it("reports Done once the timer fires, and Failed with a compiler error for a 'broken' upload", async () => {
    vi.useFakeTimers();
    try {
      const upload = (name: string) =>
        developerApi.submitContract({
          file: new File(["pragma solidity ^0.8.19;\ncontract A {}\n"], name),
          developerAddress: `0x${"d1".repeat(20)}`,
          bountyAmount: "1000000000000000000",
          deadline: "2030-01-01T00:00:00.000Z",
        });
      const good = await upload("A.sol");
      const broken = await upload("BrokenVault.sol");
      await vi.advanceTimersByTimeAsync(ANALYSIS_DELAY_MS);

      expect(await developerApi.getAnalysisStatus(good.id)).toMatchObject({ status: "Done", error: null });
      expect(isAnalysisDone(good.id)).toBe(true);
      const failed = await developerApi.getAnalysisStatus(broken.id);
      expect(failed).toMatchObject({ status: "Failed", findingCount: 0 });
      expect(failed.error).toContain("BrokenVault.sol");
      expect(isAnalysisDone(broken.id)).toBe(false);
      expect(await developerApi.getBounty(broken.id)).toMatchObject({ contractId: broken.id });
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns 404 for an unknown contract", async () => {
    await expect(developerApi.getAnalysisStatus("contract_missing")).rejects.toMatchObject({
      status: 404,
    });
  });
});
